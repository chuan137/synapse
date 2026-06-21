import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { readMessages, sendMessage, updateStatus, claimAgentSlot, setAgentName, getMostRecentInProgressTask, getAgentState, setAgentReady } from './db.js';

// Checks if a message body looks like a numbered or bulleted option list.
// Used to enforce request_options when send_message targets 'human' with needs_approval.
function looksLikeOptionList(content: string): boolean {
  return /^\s*\d+[.)]/m.test(content) || /^[-•]\s/m.test(content);
}

// ── Agent identity ─────────────────────────────────────────────────────────

interface Settings {
  projectId: string; // stable per-project, written once
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


const isFirstInit = !existsSync(join(SYNAPSE_DIR, 'settings.json'));
const settings = loadSettings();
const SESSION_ID  = process.env.CLAUDE_CODE_SESSION_ID ?? null;
const TMUX_PANE   = process.env.TMUX_PANE ?? null;
const FORCED_SLOT = process.env.SYNAPSE_SLOT !== undefined ? parseInt(process.env.SYNAPSE_SLOT, 10) : undefined;
const { agentId: AGENT_ID, slot } = claimAgentSlot(settings.projectId, SESSION_ID, TMUX_PANE, FORCED_SLOT);

// Ensure orchestrator always shows name "orchestrator" if not yet set.
// Workers get their name from setAgentName() called by spawnWorker — never from settings.json.
if (slot === 0) {
  setAgentName(AGENT_ID, 'orchestrator');
}

// Write agent ID so `synapse task/worker/decision/approve/history/done` CLI
// subcommands (run via this agent's own Bash tool) know who is calling —
// see resolveSelfAgentId() in agent-actions.ts.
writeFileSync(join(SYNAPSE_DIR, 'agent.env'), `SYNAPSE_AGENT_ID=${AGENT_ID}\n`, 'utf8');

if (isFirstInit) {
  process.stderr.write(`[Synapse] Project initialized (${settings.projectId}). You are :${slot}. Run \`synapse dash\` to open S-Deck.\n`);
} else {
  process.stderr.write(`[Synapse] Connected as ${AGENT_ID} (:${slot}).\n`);
}

const server = new Server(
  { name: 'synapse-bus', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ───────────────────────────────────────────────────────

// Only the three highest-frequency, called-every-turn actions remain MCP tools.
// Everything else (spawn_agent, list_workers, request_approval, get_history,
// start_task, finish_task, delegate_task, log_decision, report_done) moved to
// `synapse <subcommand>` CLI calls — see agent-actions.ts and index.ts. That
// shrinks the per-turn tool-schema every agent pays for on every API call,
// regardless of whether a tool is actually invoked that turn.
const ORCH_ONLY_TOOLS = new Set<string>([]);
const WORKER_ONLY_TOOLS = new Set<string>([]);

const ALL_TOOLS = [
    {
      name: 'read_messages',
      description:
        `Call at the START of every turn. Your agent ID is "${AGENT_ID}". ` +
        'Returns unread messages addressed to you, ordered by priority (0=urgent). ' +
        'Each element: { id, from, priority: 0|5, at, content }. Use `id` as `source_msg_id` in start_task. ' +
        'Pass state/current_task to report your status in the same call instead of a separate update_status — ' +
        'use this when you\'re reporting idle/blocked and immediately waiting for the next message (saves a round-trip).',
      inputSchema: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            enum: ['idle', 'working', 'error'],
            description: 'Optional: report this status before checking messages (e.g. "idle" when entering a wait loop).',
          },
          current_task: {
            type: 'string',
            description: 'Optional, paired with state — short description (e.g. "awaiting worker X on task N").',
          },
        },
        required: [],
      },
    },
    {
      name: 'send_message',
      description:
        'Send a message to "human" (the operator) or another agent\'s agent_id. Keep it short. ' +
        'needs_approval: true shows an Approve button on S-Deck. ' +
        'request_options presents clickable choices (requires needs_approval: true).',
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
          report_file: {
            type: 'boolean',
            description: 'If true and to_id is "human", write the full content to .synapse/reports/<timestamp>-<slug>.md and send a truncated summary with the file path instead. Use when the message is longer than ~20 lines.',
            default: false,
          },
          needs_approval: {
            type: 'boolean',
            description: 'Required when to_id is "human". Set true if this message requires operator action (shows an Approve button in S-Deck); set false for informational messages.',
            default: false,
          },
          request_options: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of choices to present to the operator as clickable buttons. Use when the message requires the operator to pick one of several options. Requires needs_approval: true.',
          },
          task_id: {
            oneOf: [{ type: 'number' }, { type: 'null' }],
            description: 'The task this message is associated with. Pass the task_id from start_task, or null if not task-scoped.',
          },
          type: {
            type: 'string',
            enum: ['message', 'done', 'decision', 'finding', 'blocked', 'commit', 'hint'],
            default: 'message',
            description: 'Message type. Use "done" when reporting task completion, "decision" for choices made, "finding" for discoveries, "blocked" when stuck, "commit" for commit notifications. "hint" is reserved for system-generated advisories (reflect-gate, health-monitor) — set by system callers only. Defaults to "message".',
          },
        },
        required: ['to_id', 'content', 'type'],
      },
    },
    {
      name: 'update_status',
      description:
        'Report your current state to the operator dashboard. Call this whenever your state changes AND at the END of every turn. ' +
        "State is one of: idle (loop alive, waiting), working (processing a turn), error (unrecoverable failure). " +
        "'blocked' is set automatically by the system when you stall on an interactive prompt — do not report it yourself.",
      inputSchema: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            enum: ['idle', 'working', 'error'],
            description: 'Your current state. Do not report blocked — the system sets it automatically.',
          },
          current_task: {
            type: 'string',
            description: 'Short human-readable description of what you are doing',
          },
        },
        required: ['state'],
      },
    },
];

const IS_ORCHESTRATOR = slot === 0;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS.filter((t) => {
    if (ORCH_ONLY_TOOLS.has(t.name)) return IS_ORCHESTRATOR;
    if (WORKER_ONLY_TOOLS.has(t.name)) return !IS_ORCHESTRATOR;
    return true;
  }),
}));

// ── Tool handlers ──────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Defense in depth: a role-mismatched tool is no longer advertised in ListTools,
  // but guard the call path too in case a stale client cache or hallucinated call
  // slips through.
  if (ORCH_ONLY_TOOLS.has(name) && !IS_ORCHESTRATOR) {
    return { content: [{ type: 'text', text: `${name} is orchestrator-only — workers never call it.` }], isError: true };
  }
  if (WORKER_ONLY_TOOLS.has(name) && IS_ORCHESTRATOR) {
    return { content: [{ type: 'text', text: `${name} is worker-only — the orchestrator never calls it.` }], isError: true };
  }

  if (name === 'read_messages') {
    const { state, current_task } = (args ?? {}) as { state?: 'idle' | 'working' | 'error'; current_task?: string };
    if (state) {
      updateStatus(AGENT_ID, state, current_task ?? null, null, null);
    }

    const msgs = readMessages(AGENT_ID);

    const reminder = '\n\n[Synapse] Now call update_status to report your current state.';

    if (msgs.length === 0) {
      return { content: [{ type: 'text', text: `No new messages.${reminder}` }] };
    }

    // Auto-advance status idle → working so S-Deck reflects the agent is processing messages.
    // Only fires from idle to avoid overwriting blocked/error/working states.
    if (getAgentState(AGENT_ID) === 'idle') {
      const senders = [...new Set(msgs.map(m => m.from_id))];
      const senderStr = senders.length === 1 ? senders[0] : senders.slice(0, 2).join(', ') + (senders.length > 2 ? ', …' : '');
      updateStatus(AGENT_ID, 'working', `reading ${msgs.length} message${msgs.length === 1 ? '' : 's'} from ${senderStr}`, null, null);
    }

    // Server-side spawn ACK: if any delivered message is a handshake, mark this worker as ready.
    // This is idempotent — setAgentReady only writes once (when ready_at IS NULL).
    const hasHandshake = msgs.some(m => {
      try { return (JSON.parse(m.content as string) as any)?.type === 'handshake'; } catch { return false; }
    });
    if (hasHandshake) setAgentReady(AGENT_ID);

    const array = msgs.map((m) => ({
      id: m.id,
      from: m.from_id,
      priority: m.priority,
      at: new Date(m.created_at).toISOString(),
      content: m.content,
      type: m.type ?? 'message',
    }));

    return {
      content: [
        { type: 'text', text: JSON.stringify(array, null, 2) },
        { type: 'text', text: reminder.trim() },
      ],
    };
  }

  if (name === 'send_message') {
    const { to_id, content, priority = 5, report_file = false, needs_approval = false, request_options, task_id, type } = args as {
      to_id: string;
      content: string;
      priority?: number;
      report_file?: boolean;
      needs_approval?: boolean;
      request_options?: string[];
      task_id?: number | null;
      type?: string | null;
    };

    if (to_id === 'human' && !('needs_approval' in (args as object))) {
      return { content: [{ type: 'text', text: 'needs_approval is required when messaging human. Set needs_approval: true if this message requires operator action, or needs_approval: false for informational messages.' }], isError: true };
    }
    // If needs_approval and content looks like an option list, require request_options
    const hasOptions = Array.isArray(request_options) && request_options.length > 0;
    if (to_id === 'human' && needs_approval && !hasOptions && looksLikeOptionList(content)) {
      return { content: [{ type: 'text', text: 'This message presents options to the human but request_options is not set. Pass request_options: ["option 1 text", "option 2 text"] so the operator sees clickable buttons.' }], isError: true };
    }

    if (report_file && to_id === 'human') {
      const reportsDir = join(process.cwd(), '.synapse', 'reports');
      mkdirSync(reportsDir, { recursive: true });
      const slug = content.split('\n')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
      const filename = `${Date.now()}-${slug}.md`;
      writeFileSync(join(reportsDir, filename), content, 'utf8');
      const lines = content.split('\n');
      const summary = lines.slice(0, 10).join('\n');
      const shortMsg = `${summary}${lines.length > 10 ? '\n…' : ''}\n\n[Full report: .synapse/reports/${filename}]`;
      sendMessage(AGENT_ID, to_id, shortMsg, priority, needs_approval, request_options, task_id ?? null, type ?? null);
      return { content: [{ type: 'text', text: 'Message sent (report filed).' }] };
    }

    sendMessage(AGENT_ID, to_id, content, priority, needs_approval, request_options, task_id ?? null, type ?? null);

    return {
      content: [
        { type: 'text', text: `Message sent to ${to_id} (priority ${priority}).` },
      ],
    };
  }

  if (name === 'update_status') {
    const { state, current_task } = args as {
      state: 'idle' | 'working' | 'error';
      current_task?: string;
    };

    updateStatus(AGENT_ID, state, current_task ?? null, null, null);

    return {
      content: [
        {
          type: 'text',
          text: `Status updated: ${state}${current_task ? ` — ${current_task}` : ''}`,
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
