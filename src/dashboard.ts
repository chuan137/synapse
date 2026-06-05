import express, { Request, Response } from 'express';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, statSync, watchFile } from 'fs';
import { execSync, spawnSync } from 'child_process';
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
  listAllActivities,
  purgeStaleAgents,
  reapGhostAgents,
  updateAgentConfig,
  getAgentById,
  AgentStatus,
  Message,
  ApprovalRequest,
} from './db.js';
import { spawnWorker } from './spawn.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.SYNAPSE_PORT ?? '4000', 10);
const PROJECT_NAME = basename(process.cwd());

function readProjectId(): string | null {
  const p = join(process.cwd(), '.synapse', 'settings.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')).projectId ?? null; } catch { return null; }
}

// ── PLAN.md file-watch ────────────────────────────────────────────────────

const PLAN_PATH = join(process.cwd(), 'PLAN.md');

function readPlan(): { content: string; updated_at: number } {
  try {
    const content = readFileSync(PLAN_PATH, 'utf8');
    const updated_at = statSync(PLAN_PATH).mtimeMs;
    return { content, updated_at };
  } catch {
    return { content: '', updated_at: 0 };
  }
}

let currentPlan = readPlan();

// Use watchFile (stat-poll) — more reliable than fs.watch across editors/NFS.
watchFile(PLAN_PATH, { interval: 1500 }, () => {
  const next = readPlan();
  if (next.content !== currentPlan.content || next.updated_at !== currentPlan.updated_at) {
    currentPlan = next;
    broadcastPlan();
  }
});

function broadcastPlan() {
  broadcast({
    statuses: getAllStatuses(),
    messages: getRecentMessages(200),
    approvals: getPendingApprovals(),
    events: getRecentEvents(200),
    metrics: getAllToolMetrics(),
    activities: listAllActivities(200),
    plan: currentPlan,
  });
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
let lastStatuses   = '';
let lastMessages   = '';
let lastApprovals  = '';
let lastEvents     = '';
let lastActivities = '';
let lastPlan       = '';

// agent_id → newest unread message id we've already nudged about (de-dupe).
const nudgedMsgId = new Map<string, number>();

setInterval(() => {
  const statuses   = getAllStatuses();
  const messages   = getRecentMessages(200);
  const approvals  = getPendingApprovals();
  const events     = getRecentEvents(200);
  const metrics    = getAllToolMetrics();
  const activities = listAllActivities(200);

  const statusStr     = JSON.stringify(statuses);
  const msgStr        = JSON.stringify(messages.map((m) => m.id));
  const approvalStr   = JSON.stringify(approvals.map((a) => a.id));
  const eventStr      = JSON.stringify(events.map((e) => e.id));
  const activityStr   = JSON.stringify(activities.map((a) => `${a.id}:${a.status}:${a.commit_sha}`));
  const planStr       = `${currentPlan.updated_at}`;

  if (
    statusStr !== lastStatuses ||
    msgStr !== lastMessages ||
    approvalStr !== lastApprovals ||
    eventStr !== lastEvents ||
    activityStr !== lastActivities ||
    planStr !== lastPlan
  ) {
    lastStatuses   = statusStr;
    lastMessages   = msgStr;
    lastApprovals  = approvalStr;
    lastEvents     = eventStr;
    lastActivities = activityStr;
    lastPlan       = planStr;
    broadcast({ statuses, messages, approvals, events, metrics, activities, plan: currentPlan });
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
  // Detect the running terminal via System Events, then activate it in a separate
  // tell block. Activating inside a System Events context races on iTerm2 — the
  // nested tell can fire before System Events has fully resolved the process, dropping
  // the focus request. Two tell blocks, one osascript spawn — still no extra latency.
  const script = `
tell application "System Events"
  set runningNames to name of every process whose background only is false
end tell
repeat with appName in {${TERMINALS.map(t => `"${t}"`).join(', ')}}
  if runningNames contains appName then
    set appStr to appName as text
    tell application appStr to activate
    return appStr
  end if
end repeat`;
  try {
    const raised = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { stdio: 'pipe' }).toString().trim();
    if (raised) process.stderr.write(`[Synapse] raised ${raised}\n`);
  } catch { /* AppleScript failed, not fatal */ }
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
    activities: listAllActivities(200),
    plan: currentPlan,
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

// Kill + respawn a worker agent in the same role (restart)
app.post('/api/agents/:agentId/restart', (req: Request, res: Response) => {
  const agentId = String(req.params.agentId);
  const agent = getAgentById(agentId);

  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.slot === 0) { res.status(400).json({ error: 'Cannot restart the orchestrator (slot 0)' }); return; }
  if (agent.ended_at !== null) { res.status(409).json({ error: 'Agent is already ended' }); return; }
  if (!agent.tmux_pane) { res.status(409).json({ error: 'Agent has no tmux pane — cannot kill it' }); return; }

  const { slot, role, name, tmux_pane } = agent;

  try {
    execSync(`tmux kill-pane -t ${tmux_pane}`);
  } catch (e) {
    process.stderr.write(`[Synapse] restart: kill-pane failed for ${tmux_pane}: ${e}\n`);
    // Pane may already be gone — continue so reap cleans up the row
  }

  // Brief wait for pane death and any post-stop hooks to fire
  spawnSync('sleep', ['0.25']);

  // Reap ghost + purge so the old slot row is tidied before we claim a new one
  const reaped = reapGhostAgents();
  const purged = purgeStaleAgents();
  process.stderr.write(`[Synapse] restart reap: ${reaped} marked ended, ${purged} purged\n`);

  const dbPath = process.env.SYNAPSE_DB_PATH ?? join(process.cwd(), '.synapse', 'synapse.db');
  const workerRole = role ?? 'worker';
  const restartTask =
    `You are a long-lived ${workerRole} worker (restarted). Your orchestrator is cec50b17:0. ` +
    `Loop waiting for task messages on the Synapse bus. Your previous slot was :${slot}; ` +
    `the orchestrator may or may not have queued work for you while you were offline — read_messages first.`;

  const worker = spawnWorker({
    role: workerRole,
    name: name ?? undefined,
    task: restartTask,
    projectDir: process.cwd(),
    dbPath,
    slot,
  });

  if (!worker) {
    res.status(500).json({ error: 'Worker spawned but did not register within 60s' });
    return;
  }

  res.json({ ok: true, agent_id: worker.agent_id });
});

// Update agent config (name, model, effort) from the dashboard
app.patch('/api/agents/:agentId', (req: Request, res: Response) => {
  const agentId = String(req.params.agentId);
  const { name, model, effort } = req.body as { name?: string | null; model?: string | null; effort?: string | null };
  const fields: { name?: string | null; model?: string | null; effort?: string | null } = {};
  if ('name'   in req.body) fields.name   = name   || null;
  if ('model'  in req.body) fields.model  = model  || null;
  if ('effort' in req.body) fields.effort = effort || null;
  updateAgentConfig(agentId, fields);

  // If a new model was set and the agent has a live pane, apply it immediately
  // by sending the /model slash command and confirming the switch.
  if (fields.model) {
    const pane = getTmuxPane(agentId);
    if (pane) {
      try {
        execSync(`tmux send-keys -t ${pane} '/model ${fields.model}' Enter`);
        // Brief pause for the confirmation prompt to appear, then confirm option 1.
        setTimeout(() => {
          try { execSync(`tmux send-keys -t ${pane} '1' Enter`); } catch { /* best-effort */ }
        }, 800);
        process.stderr.write(`[Synapse] sent /model ${fields.model} to pane ${pane}\n`);
      } catch { /* best-effort — agent may not be at a prompt */ }
    }
  }

  res.json({ ok: true });
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
    activities: listAllActivities(200),
    plan: currentPlan,
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
