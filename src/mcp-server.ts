import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { spawnSync } from 'child_process';
import { readMessages, sendMessage, updateStatus, claimAgentSlot, createApprovalRequest, pollApproval, getAgentHistory, listLiveWorkers, reapGhostAgents, purgeStaleAgents, setAgentName, startActivity, finishActivity } from './db.js';
import { spawnWorker } from './spawn.js';

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

function listAvailableRoles(): string {
  const rolesDir = join(TEMPLATES_DIR, 'roles');
  if (!existsSync(rolesDir)) return 'No roles defined yet.';
  const roles = readdirSync(rolesDir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const content = readFileSync(join(rolesDir, f), 'utf8');
      const match = content.match(/^---\n([\s\S]*?)\n---/);
      if (!match) return null;
      const block = match[1];
      const role = (block.match(/^role:\s*(.+)$/m) ?? [])[1]?.trim() ?? f.replace('.md', '');
      const description = (block.match(/^description:\s*(.+)$/m) ?? [])[1]?.trim() ?? '';
      return `- **${role}**: ${description}`;
    })
    .filter(Boolean)
    .join('\n');
  return roles || 'No roles defined yet.';
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

// Write agent ID so the PostToolUse hook can look up unread messages.
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
    {
      name: 'spawn_agent',
      description:
        'Spawn a new long-lived Claude worker agent in a tmux window. ' +
        'The agent will register itself in Synapse and you can message it via its returned agent_id. ' +
        'Every worker should have a role — check the pool for an idle matching worker before spawning. ' +
        `Available roles:\n${listAvailableRoles()}\n` +
        'If no role fits, ask the human to define one before spawning.',
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
          role: {
            type: 'string',
            description: 'Worker role to load. Use "worker" for generic, or a named role like "code-reviewer". Named roles load templates/roles/<name>.md on top of the base worker instructions.',
          },
          slot: {
            type: 'number',
            description: 'Optional slot number to assign to this agent. If omitted, the next available slot is used.',
          },
        },
        required: ['task'],
      },
    },
    {
      name: 'list_workers',
      description:
        'List live worker agents in the pool. Filter by role and/or state. ' +
        'Use this BEFORE spawning a new worker — if an idle worker with the matching role exists, message it instead of spawning.',
      inputSchema: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            description: 'Only list workers with this role.',
          },
          state: {
            type: 'string',
            enum: ['idle', 'working', 'blocked', 'error'],
            description: 'Only list workers in this state.',
          },
        },
        required: [],
      },
    },
    {
      name: 'pick_worker',
      description:
        'Convenience: return ONE worker\'s agent_id matching the filters, preferring idle. ' +
        'Returns null if none match. Saves the orchestrator from filtering manually.',
      inputSchema: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            description: 'Required. The role to match.',
          },
          prefer: {
            type: 'string',
            enum: ['idle', 'any'],
            description: "Prefer an idle worker. 'idle' (default) returns null if none are idle; 'any' falls back to the first matching worker.",
          },
        },
        required: ['role'],
      },
    },
    {
      name: 'request_approval',
      description:
        'Ask the human operator for approval before proceeding. ' +
        'This blocks until the operator approves or rejects via S-Deck. ' +
        'Use for destructive actions, irreversible changes, or when you genuinely cannot decide.',
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'The yes/no question for the operator. Be specific.',
          },
          context: {
            type: 'string',
            description: 'Additional context to help the operator decide.',
          },
        },
        required: ['question'],
      },
    },
    {
      name: 'get_history',
      description:
        'Retrieve recent message history for this agent (both sent and received). ' +
        'Use this to recall context from earlier in the session when messages have already been read.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of messages to return (default: 10, max: 50).',
          },
        },
        required: [],
      },
    },
    {
      name: 'start_activity',
      description:
        'Begin tracking a task you\'ve taken on. Call this when you receive a substantive task assignment ' +
        'from your orchestrator (or, for orchestrators, from the human). The Activity will appear in the ' +
        'operator\'s S-Deck Activities panel for this agent. Returns an activity_id you must pass to ' +
        'finish_activity when done. Skip for trivial back-and-forth — only use for tasks worth a recap entry.',
      inputSchema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Short description of the task (e.g. "Implement worktree CLI subcommands").',
          },
          trigger_msg_id: {
            type: 'number',
            description: 'Message id of the task assignment that triggered this activity (optional).',
          },
        },
        required: ['title'],
      },
    },
    {
      name: 'finish_activity',
      description:
        'Mark an activity as done. Pass the activity_id from start_activity, status=\'completed\' or \'aborted\', ' +
        'and optionally result_msg_id (the message id of your DONE/result message — links the activity to its ' +
        'resolution in the UI).',
      inputSchema: {
        type: 'object',
        properties: {
          activity_id: {
            type: 'number',
            description: 'The id returned by start_activity.',
          },
          status: {
            type: 'string',
            enum: ['completed', 'aborted'],
            description: '\'completed\' if the task succeeded, \'aborted\' if it was cancelled or failed.',
          },
          result_msg_id: {
            type: 'number',
            description: 'Message id of the DONE/result message you sent (optional).',
          },
          commit_sha: {
            type: 'string',
            description: 'Short commit SHA if this activity produced a commit (optional — set automatically by the hook if omitted).',
          },
        },
        required: ['activity_id', 'status'],
      },
    },
  ],
}));

// ── Tool handlers ──────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'read_messages') {
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

  if (name === 'spawn_agent') {
    const { task, name: workerName, role: workerRole = 'worker', slot: forcedSlot } = args as { task: string; name?: string; role?: string; slot?: number };

    // Reap ghost agents (pane gone without graceful end) then purge retired rows
    // so stale slot numbers are freed before we claim a new one.
    const reaped = reapGhostAgents();
    const purged = purgeStaleAgents();
    if (reaped > 0 || purged > 0) {
      console.log(`[spawn_agent] ghost reap: ${reaped} marked ended, ${purged} purged`);
    }

    const dbPath = process.env.SYNAPSE_DB_PATH ?? join(process.cwd(), '.synapse', 'synapse.db');
    const windowName = (workerName ?? workerRole).replace(/[^a-zA-Z0-9_-]/g, '-');

    const worker = spawnWorker({
      role: workerRole,
      name: workerName,
      slot: forcedSlot,
      task,
      projectDir: process.cwd(),
      dbPath,
    });

    if (!worker) {
      return { content: [{ type: 'text', text: `Worker spawned in tmux window "${windowName}" but has not registered yet. Check S-Deck.` }] };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Spawned agent ${worker.agent_id} (slot :${worker.slot}, role: ${workerRole}) in tmux window "${windowName}". ` +
                `Send it messages using to_id = "${worker.agent_id}".`,
        },
      ],
    };
  }

  if (name === 'list_workers') {
    const { role, state } = args as { role?: string; state?: 'idle' | 'working' | 'blocked' | 'error' };
    const workers = listLiveWorkers({ role, state });

    if (workers.length === 0) {
      return { content: [{ type: 'text', text: 'No live workers match.' }] };
    }

    const fmtAge = (ms: number) => {
      const s = Math.round(ms / 1000);
      return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
    };

    const rows = workers.map((w) =>
      `:${w.slot}\t${w.agent_id}\t${w.role ?? '-'}\t${w.name || '-'}\t${w.state}\t${w.current_task ?? '-'}\t${fmtAge(w.last_seen_ms_ago)}`
    );
    const header = 'slot\tagent_id\trole\tname\tstate\tcurrent_task\tlast_seen';
    const text = `${workers.length} live worker(s):\n\n${header}\n${rows.join('\n')}`;

    return { content: [{ type: 'text', text }] };
  }

  if (name === 'pick_worker') {
    const { role, prefer = 'idle' } = args as { role: string; prefer?: 'idle' | 'any' };
    const workers = listLiveWorkers({ role });

    const idle = workers.find((w) => w.state === 'idle');
    const chosen = idle ?? (prefer === 'any' ? workers[0] : undefined);

    const result = chosen
      ? { agent_id: chosen.agent_id, slot: chosen.slot, state: chosen.state }
      : { agent_id: null };

    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }

  if (name === 'request_approval') {
    const { question, context } = args as { question: string; context?: string };

    const id = createApprovalRequest(AGENT_ID, question, context ?? null);

    // Notify operator via message
    sendMessage(AGENT_ID, 'human', `[Approval needed] ${question}${context ? `\n\nContext: ${context}` : ''}`, 0);

    // Poll until resolved (max 10 min)
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      spawnSync('sleep', ['3']);
      const req = pollApproval(id);
      if (req && req.status !== 'pending') {
        const approved = req.status === 'approved';
        return {
          content: [{
            type: 'text',
            text: `${approved ? '✓ Approved' : '✗ Rejected'}${req.comment ? `: ${req.comment}` : ''}`
          }],
        };
      }
    }

    return {
      content: [{ type: 'text', text: 'Approval request timed out after 10 minutes. Treat as rejected.' }],
    };
  }

  if (name === 'get_history') {
    const { limit = 10 } = args as { limit?: number };
    const clampedLimit = Math.min(Math.max(1, limit), 50);
    const msgs = getAgentHistory(AGENT_ID, clampedLimit);

    if (msgs.length === 0) {
      return { content: [{ type: 'text', text: 'No message history found.' }] };
    }

    const formatted = msgs
      .map((m) => {
        const ts = new Date(m.created_at).toISOString();
        const direction = m.from_id === AGENT_ID ? `→ ${m.to_id}` : `← ${m.from_id}`;
        const label = m.priority === 0 ? '[P0]' : '[P5]';
        const readMark = m.read_at ? '' : ' [unread]';
        return `${label} ${direction} at ${ts}${readMark}\n${m.content}`;
      })
      .join('\n\n---\n\n');

    return { content: [{ type: 'text', text: `${msgs.length} message(s):\n\n${formatted}` }] };
  }

  if (name === 'start_activity') {
    const { title, trigger_msg_id } = args as { title: string; trigger_msg_id?: number };
    const activityId = startActivity(AGENT_ID, title, trigger_msg_id ?? null);
    return { content: [{ type: 'text', text: `Activity started (id: ${activityId}).` }] };
  }

  if (name === 'finish_activity') {
    const { activity_id, status, result_msg_id, commit_sha } = args as {
      activity_id: number;
      status: 'completed' | 'aborted';
      result_msg_id?: number;
      commit_sha?: string;
    };
    const ok = finishActivity(activity_id, status, result_msg_id ?? null, commit_sha ?? null);
    return { content: [{ type: 'text', text: ok ? `Activity ${activity_id} marked ${status}.` : `Activity ${activity_id} not found or already finished.` }] };
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
