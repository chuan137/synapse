import express, { Request, Response } from 'express';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import {
  getAllStatuses,
  getRecentMessages,
  sendMessage,
  getTmuxPane,
  getPendingApprovals,
  resolveApproval,
  getIdleAgentsWithUnreadSignature,
  getRecentEvents,
  getAllToolMetrics,
  purgeStaleAgents,
  AgentStatus,
  Message,
  ApprovalRequest,
} from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.SYNAPSE_PORT ?? '4000', 10);
const PROJECT_NAME = basename(process.cwd());

function readProjectId(): string | null {
  const p = join(process.cwd(), '.synapse', 'settings.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')).projectId ?? null; } catch { return null; }
}

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (!req.path.startsWith('/events')) {
    process.stderr.write(`[Synapse] ${req.method} ${req.path}\n`);
  }
  next();
});
app.use(express.static(join(__dirname, '..', 'public')));

// ── SSE clients ────────────────────────────────────────────────────────────

const sseClients = new Set<Response>();

function broadcast(data: object) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// Poll DB every 500ms and push state to all connected dashboards
let lastStatuses  = '';
let lastMessages  = '';
let lastApprovals = '';
let lastEvents    = '';

// agent_id → newest unread message id we've already nudged about (de-dupe).
const nudgedMsgId = new Map<string, number>();

setInterval(() => {
  const statuses  = getAllStatuses();
  const messages  = getRecentMessages(200);
  const approvals = getPendingApprovals();
  const events    = getRecentEvents(200);
  const metrics   = getAllToolMetrics();

  const statusStr   = JSON.stringify(statuses);
  const msgStr      = JSON.stringify(messages.map((m) => m.id));
  const approvalStr = JSON.stringify(approvals.map((a) => a.id));
  const eventStr    = JSON.stringify(events.map((e) => e.id));

  if (
    statusStr !== lastStatuses ||
    msgStr !== lastMessages ||
    approvalStr !== lastApprovals ||
    eventStr !== lastEvents
  ) {
    lastStatuses  = statusStr;
    lastMessages  = msgStr;
    lastApprovals = approvalStr;
    lastEvents    = eventStr;
    broadcast({ statuses, messages, approvals, events, metrics });
  }

  // Nudge is decoupled from the broadcast: it must NOT re-fire on every event/
  // status delta. Fire once per agent each time its newest unread message id
  // advances; reset the memory once the agent has no unread messages (so a
  // future message nudges again).
  for (const row of getIdleAgentsWithUnreadSignature()) {
    const lastNudged = nudgedMsgId.get(row.agent_id) ?? 0;
    if (row.max_msg_id > lastNudged) {
      if (pingAgent(row.agent_id)) {
        nudgedMsgId.set(row.agent_id, row.max_msg_id);
      }
    }
  }
  // Forget agents that now have zero unread (they dropped out of the query),
  // so the next message they receive nudges cleanly.
  const stillUnread = new Set(getIdleAgentsWithUnreadSignature().map((r) => r.agent_id));
  for (const id of nudgedMsgId.keys()) {
    if (!stillUnread.has(id)) nudgedMsgId.delete(id);
  }
}, 500);

// ── Routes ─────────────────────────────────────────────────────────────────

app.get('/api/info', (_req: Request, res: Response) => {
  res.json({ project: PROJECT_NAME, projectId: readProjectId() });
});

function pingAgent(agentId: string): boolean {
  const pane = getTmuxPane(agentId);
  if (!pane) return false;
  try {
    execSync(`tmux send-keys -t ${pane} '[synapse] you have unread messages, call read_messages' Enter`);
    return true;
  } catch { return false; }
}

app.post('/api/ping/:agentId', (req: Request, res: Response) => {
  const agentId = String(req.params.agentId);
  const ok = pingAgent(agentId);
  if (!ok) { res.status(404).json({ error: 'No tmux pane for this agent' }); return; }
  res.json({ ok: true });
});

/** Try to raise the terminal window on macOS using AppleScript. Best-effort. */
function raiseTerminal(): void {
  const TERMINALS = ['iTerm2', 'Terminal', 'Ghostty', 'Warp', 'Alacritty', 'kitty'];
  let running: string;
  try {
    running = execSync(
      `osascript -e 'tell application "System Events" to get name of every process whose background only is false'`,
      { stdio: 'pipe' }
    ).toString();
  } catch { return; }
  for (const app of TERMINALS) {
    if (!running.includes(app)) continue;
    try {
      execSync(`osascript -e 'tell application "${app}" to activate'`, { stdio: 'pipe' });
      process.stderr.write(`[Synapse] raised ${app}\n`);
    } catch { /* AppleScript failed, not fatal */ }
    return;
  }
}

app.post('/api/focus/:agentId', (req: Request, res: Response) => {
  const agentId = String(req.params.agentId);
  const pane = getTmuxPane(agentId);
  process.stderr.write(`[Synapse] focus ${agentId} → pane=${pane}\n`);
  if (!pane) { res.status(404).json({ error: 'No tmux pane for this agent' }); return; }
  try {
    // select-pane moves focus within the session; switch-client then jumps any
    // attached terminal clients to that window so the user sees the switch.
    execSync(`tmux select-pane -t ${pane} && tmux switch-client -t ${pane}`);
    raiseTerminal();
    process.stderr.write(`[Synapse] focus OK\n`);
    res.json({ ok: true });
  } catch (e: unknown) {
    process.stderr.write(`[Synapse] focus FAILED: ${e}\n`);
    res.status(500).json({ error: String(e) });
  }
});

// Initial state snapshot
app.get('/api/state', (_req: Request, res: Response) => {
  res.json({
    statuses: getAllStatuses(),
    messages: getRecentMessages(200),
    approvals: getPendingApprovals(),
    events: getRecentEvents(200),
    metrics: getAllToolMetrics(),
  });
});

// Resolve an approval request
app.post('/api/approvals/:id/resolve', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const { status, comment } = req.body as { status: 'approved' | 'rejected'; comment?: string };
  if (!['approved', 'rejected'].includes(status)) {
    res.status(400).json({ error: 'status must be approved or rejected' });
    return;
  }
  resolveApproval(id, status, comment ?? null);
  res.json({ ok: true });
});

// Operator sends a message to an agent
app.post('/api/messages', (req: Request, res: Response) => {
  const { to_id, content, priority } = req.body as {
    to_id: string;
    content: string;
    priority?: number;
  };

  if (!to_id || !content) {
    res.status(400).json({ error: 'to_id and content are required' });
    return;
  }

  const p = priority ?? 5;
  sendMessage('human', to_id, content, p);
  if (p === 0) pingAgent(to_id);
  res.json({ ok: true });
});

// Purge stale ended agents that have no real history
app.post('/api/agents/purge', (_req: Request, res: Response) => {
  const count = purgeStaleAgents();
  res.json({ ok: true, purged: count });
});

// SSE stream
app.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial state immediately
  const initial = JSON.stringify({
    statuses: getAllStatuses(),
    messages: getRecentMessages(200),
    approvals: getPendingApprovals(),
    events: getRecentEvents(200),
    metrics: getAllToolMetrics(),
  });
  res.write(`data: ${initial}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

export function startDashboard(port = PORT): Promise<number> {
  return new Promise((resolve) => {
    const srv = app.listen(port, () => {
      const addr = srv.address() as { port: number };
      process.stderr.write(`[Synapse] S-Deck live at http://localhost:${addr.port}\n`);
      resolve(addr.port);
    });
  });
}

// Allow direct invocation: `node dist/dashboard.js`
if (process.argv[1]?.endsWith('dashboard.js') || process.argv[1]?.endsWith('dashboard.ts')) {
  startDashboard();
}
