import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { execSync, spawnSync } from 'child_process';
import { readMessages, sendMessage, updateStatus, claimAgentSlot, getLatestAgent } from './db.js';

// ── Agent identity ─────────────────────────────────────────────────────────

interface Settings {
  projectId: string; // stable per-project, written once
  name?: string;     // human-readable agent name, mutable
}

const SYNAPSE_DIR = join(process.cwd(), '.synapse');
const SETTINGS_PATH = join(SYNAPSE_DIR, 'settings.json');

function loadSettings(): Settings {
  mkdirSync(SYNAPSE_DIR, { recursive: true });
  if (existsSync(SETTINGS_PATH)) {
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    if (raw.projectId) return raw as Settings;
  }
  const settings: Settings = { projectId: randomBytes(4).toString('hex') };
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
  return settings;
}

function saveSettings(patch: Partial<Settings>): void {
  const current = loadSettings();
  writeFileSync(SETTINGS_PATH, JSON.stringify({ ...current, ...patch }, null, 2), 'utf8');
}

const settings = loadSettings();
const SESSION_ID = process.env.CLAUDE_CODE_SESSION_ID ?? null;
const TMUX_PANE  = process.env.TMUX_PANE ?? null;
const { agentId: AGENT_ID } = claimAgentSlot(settings.projectId, SESSION_ID, TMUX_PANE);
let agentName = settings.name ?? '';

// Write agent ID so the PostToolUse hook can look up unread messages.
writeFileSync(join(SYNAPSE_DIR, 'agent.env'), `SYNAPSE_AGENT_ID=${AGENT_ID}\n`, 'utf8');

const server = new Server(
  { name: 'synapse-bus', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ───────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'read_messages',
      description:
        `Check for instructions from the human operator. Your agent ID is "${AGENT_ID}". ` +
        'Call this at the START of every turn before doing anything else. ' +
        'Returns unread messages addressed to you, ordered by priority (0 = urgent).',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'send_message',
      description:
        'Send a message to the human operator or another agent. ' +
        'To reach the human operator, set to_id = "human" (this is the correct value, not "synapse" or anything else). ' +
        'To message another agent, use their agent_id. ' +
        'Keep messages short — the operator is watching multiple agents.',
      inputSchema: {
        type: 'object',
        properties: {
          to_id: {
            type: 'string',
            description: 'Recipient ID. Use "human" to reach the operator. Use another agent\'s agent_id to message them directly.',
            default: 'human',
          },
          content: {
            type: 'string',
            description: 'Message content',
          },
          priority: {
            type: 'number',
            enum: [0, 5],
            description: '0 = urgent (P0), 5 = normal (P5). Default: 5.',
          },
        },
        required: ['to_id', 'content'],
      },
    },
    {
      name: 'update_status',
      description:
        'Report your current state to the operator dashboard. ' +
        'Call this whenever your state changes AND at the END of every turn. ' +
        'An unreported state makes you invisible to the operator.',
      inputSchema: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            enum: ['idle', 'working', 'blocked', 'error'],
            description: 'Your current state',
          },
          current_task: {
            type: 'string',
            description: 'Short human-readable description of what you are doing',
          },
          name: {
            type: 'string',
            description: 'Human-readable name for this agent (updates settings.json). Only send when your name changes.',
          },
        },
        required: ['state'],
      },
    },
    {
      name: 'spawn_agent',
      description:
        'Spawn a new Claude agent in a tmux window to work on a task. ' +
        'The agent will register itself in Synapse and you can message it via its returned agent_id. ' +
        'Use this to parallelize work across multiple agents.',
      inputSchema: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description: 'The task instructions to give the new agent. Be specific — this is its entire context.',
          },
          name: {
            type: 'string',
            description: 'Short human-readable name for this agent, e.g. "backend-reviewer".',
          },
        },
        required: ['task'],
      },
    },
  ],
}));

// ── Tool handlers ──────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'read_messages') {
    updateStatus(AGENT_ID, 'idle', null, agentName || null, null);
    const msgs = readMessages(AGENT_ID);

    const reminder = '\n\n[Synapse] Now call update_status to report your current state.';

    if (msgs.length === 0) {
      return { content: [{ type: 'text', text: `No new messages.${reminder}` }] };
    }

    const formatted = msgs
      .map((m) => {
        const ts = new Date(m.created_at).toISOString();
        const label = m.priority === 0 ? '[P0 — URGENT]' : '[P5]';
        return `${label} From: ${m.from_id} at ${ts}\n${m.content}`;
      })
      .join('\n\n---\n\n');

    return {
      content: [
        {
          type: 'text',
          text: `${msgs.length} new message(s):\n\n${formatted}${reminder}`,
        },
      ],
    };
  }

  if (name === 'send_message') {
    updateStatus(AGENT_ID, 'idle', null, agentName || null, null);
    const { to_id, content, priority = 5 } = args as {
      to_id: string;
      content: string;
      priority?: number;
    };

    sendMessage(AGENT_ID, to_id, content, priority);

    return {
      content: [
        { type: 'text', text: `Message sent to ${to_id} (priority ${priority}).` },
      ],
    };
  }

  if (name === 'update_status') {
    const { state, current_task, name: newName } = args as {
      state: 'idle' | 'working' | 'blocked' | 'error';
      current_task?: string;
      name?: string;
    };

    if (newName && newName !== agentName) {
      agentName = newName;
      saveSettings({ name: newName });
    }

    updateStatus(AGENT_ID, state, current_task ?? null, agentName || null, null);

    return {
      content: [
        {
          type: 'text',
          text: `Status updated: ${state}${current_task ? ` — ${current_task}` : ''}`,
        },
      ],
    };
  }

  if (name === 'spawn_agent') {
    const { task, name: workerName } = args as { task: string; name?: string };

    const dbPath = process.env.SYNAPSE_DB_PATH ?? join(process.cwd(), '.synapse', 'synapse.db');
    const slotsBefore = getLatestAgent()?.slot ?? -1;
    const windowName = workerName ?? `worker`;
    const escapedTask = task.replace(/'/g, `'\\''`);
    const escapedName = (workerName ?? '').replace(/'/g, `'\\''`);

    execSync(
      `tmux new-window -d -n '${windowName}' ` +
      `'SYNAPSE_DB_PATH=${dbPath} synapse run --role worker --task '\\''${escapedTask}'\\'`
    );

    // Poll until the worker claims its slot (max 10s)
    let worker = null;
    for (let i = 0; i < 20; i++) {
      spawnSync('sleep', ['0.5']);
      const latest = getLatestAgent();
      if (latest && latest.slot > slotsBefore) { worker = latest; break; }
    }

    if (!worker) {
      return { content: [{ type: 'text', text: `Worker spawned in tmux window "${windowName}" but has not registered yet. Check S-Deck.` }] };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Spawned agent ${worker.agent_id} (slot :${worker.slot}) in tmux window "${windowName}". ` +
                `Send it messages using to_id = "${worker.agent_id}".`,
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// ── Start ──────────────────────────────────────────────────────────────────

export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Allow direct invocation: `node dist/mcp-server.js`
if (process.argv[1]?.endsWith('mcp-server.js') || process.argv[1]?.endsWith('mcp-server.ts')) {
  await startMcpServer();
}
