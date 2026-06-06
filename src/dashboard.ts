import express, { Request, Response } from 'express';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, statSync, watchFile, writeFileSync, unlinkSync, readdirSync, mkdirSync } from 'fs';
import { execSync, spawnSync, spawn } from 'child_process';
import { parseRoleFile, serializeRoleFile, isValidRoleName, Role } from './roles.js';
import {
  getAllStatuses,
  getRecentMessages,
  sendMessage,
  approveMessage,
  selectOption,
  getTmuxPane,
  getPendingApprovals,
  resolveApproval,
  getIdleAgentsWithUnreadSignature,
  getRecentEvents,
  getAllToolMetrics,
  listAllTasks,
  purgeStaleAgents,
  reapGhostAgents,
  updateAgentConfig,
  getAgentById,
  markAgentEnded,
  getEvalResults,
  getMetricFailureCounts,
  AgentStatus,
  Message,
  ApprovalRequest,
} from './db.js';
import { spawnWorker } from './spawn.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.SYNAPSE_PORT ?? '4000', 10);
const PROJECT_NAME = basename(process.cwd());
const ROLES_DIR = join(__dirname, '..', 'templates', 'roles');

function readProjectId(): string | null {
  const p = join(process.cwd(), '.synapse', 'settings.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')).projectId ?? null; } catch { return null; }
}

// ── PLAN.md file-watch ────────────────────────────────────────────────────

const PLAN_PATH = join(process.cwd(), '.synapse', 'PLAN.md');

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
    tasks: listAllTasks(200),
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
let lastTasks      = '';
let lastPlan       = '';

// agent_id → newest unread message id we've already nudged about (de-dupe).
const nudgedMsgId = new Map<string, number>();

setInterval(() => {
  const statuses   = getAllStatuses();
  const messages   = getRecentMessages(200);
  const approvals  = getPendingApprovals();
  const events     = getRecentEvents(200);
  const metrics    = getAllToolMetrics();
  const tasks      = listAllTasks(200);

  const statusStr     = JSON.stringify(statuses);
  const msgStr        = JSON.stringify(messages.map((m) => m.id));
  const approvalStr   = JSON.stringify(approvals.map((a) => a.id));
  const eventStr      = JSON.stringify(events.map((e) => e.id));
  const taskStr       = JSON.stringify(tasks.map((a) => `${a.id}:${a.status}:${a.commit_sha}`));
  const planStr       = `${currentPlan.updated_at}`;

  if (
    statusStr !== lastStatuses ||
    msgStr !== lastMessages ||
    approvalStr !== lastApprovals ||
    eventStr !== lastEvents ||
    taskStr !== lastTasks ||
    planStr !== lastPlan
  ) {
    lastStatuses   = statusStr;
    lastMessages   = msgStr;
    lastApprovals  = approvalStr;
    lastEvents     = eventStr;
    lastTasks      = taskStr;
    lastPlan       = planStr;
    broadcast({ statuses, messages, approvals, events, metrics, tasks, plan: currentPlan });
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

// ── Settings (theme, etc.) ────────────────────────────────────────────────────

const SETTINGS_PATH = join(process.cwd(), '.synapse', 'settings.json');

function readSettings(): Record<string, unknown> {
  try {
    return existsSync(SETTINGS_PATH) ? JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) : {};
  } catch { return {}; }
}

app.get('/api/settings', (_req: Request, res: Response) => {
  res.json(readSettings());
});

app.post('/api/settings', (req: Request, res: Response) => {
  const update = req.body as Record<string, unknown>;
  const merged = { ...readSettings(), ...update };
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf8');
  res.json({ ok: true });
});

// ── Roles CRUD ───────────────────────────────────────────────────────────────
// Source of truth = templates/roles/*.md. Read lazily on every request so the
// MCP server's spawn_agent (which also reads the dir fresh) sees edits immediately.

interface RoleEntry extends Role { file: string }

/** Read + parse every role file. Files without valid front-matter are skipped (warned). */
function listRoleFiles(): RoleEntry[] {
  if (!existsSync(ROLES_DIR)) return [];
  const out: RoleEntry[] = [];
  for (const f of readdirSync(ROLES_DIR).filter(n => n.endsWith('.md'))) {
    const file = join(ROLES_DIR, f);
    const role = parseRoleFile(readFileSync(file, 'utf8'));
    if (!role) { process.stderr.write(`[Synapse] skipping role file without valid front-matter: ${f}\n`); continue; }
    out.push({ ...role, file });
  }
  return out;
}

/** Resolve a role by its front-matter slug (not filename). */
function findRoleBySlug(slug: string): RoleEntry | undefined {
  return listRoleFiles().find(r => r.name === slug);
}

/** Coerce a request body into a Role. Accepts raw markdown (`source`) or structured fields. */
function roleFromBody(body: any): Role | null {
  if (typeof body?.source === 'string') return parseRoleFile(body.source);
  if (typeof body?.name !== 'string') return null;
  return {
    name: String(body.name).trim(),
    description: typeof body.description === 'string' ? body.description.trim() : '',
    capabilities: Array.isArray(body.capabilities) ? body.capabilities.map(String) : [],
    body: typeof body.body === 'string' ? body.body : '',
  };
}

app.get('/api/roles', (_req: Request, res: Response) => {
  res.json(listRoleFiles().map(({ name, description, capabilities, body }) => ({ name, description, capabilities, body })));
});

app.get('/api/roles/:name', (req: Request, res: Response) => {
  const role = findRoleBySlug(String(req.params.name));
  if (!role) { res.status(404).json({ error: 'Role not found' }); return; }
  const { name, description, capabilities, body, file } = role;
  res.json({ name, description, capabilities, body, source: readFileSync(file, 'utf8') });
});

/** Shared write path for POST (create) and PUT (update). `urlName` is null for create. */
function writeRole(urlName: string | null, body: any, res: Response): void {
  const role = roleFromBody(body);
  if (!role) { res.status(400).json({ error: 'Invalid role: missing name or unparseable source' }); return; }
  if (!isValidRoleName(role.name)) {
    res.status(400).json({ error: 'Invalid name: must match [a-z][a-z0-9-]*' });
    return;
  }
  if (!role.description) { res.status(400).json({ error: 'description is required' }); return; }

  const existing = findRoleBySlug(role.name);
  // Reject if the target slug belongs to a *different* role than the one at :name.
  if (existing && existing.name !== urlName) {
    res.status(409).json({ error: `A role named "${role.name}" already exists` });
    return;
  }

  const target = join(ROLES_DIR, `${role.name}.md`);
  writeFileSync(target, serializeRoleFile(role), 'utf8');

  // Rename: slug changed from the URL's :name — remove the old file.
  if (urlName && urlName !== role.name) {
    const old = findRoleBySlug(urlName);
    if (old && old.file !== target && existsSync(old.file)) unlinkSync(old.file);
  }
  res.json({ name: role.name, description: role.description, capabilities: role.capabilities, body: role.body });
}

app.post('/api/roles', (req: Request, res: Response) => {
  writeRole(null, req.body, res);
});

app.put('/api/roles/:name', (req: Request, res: Response) => {
  writeRole(String(req.params.name), req.body, res);
});

app.delete('/api/roles/:name', (req: Request, res: Response) => {
  const role = findRoleBySlug(String(req.params.name));
  if (!role) { res.status(404).json({ error: 'Role not found' }); return; }
  unlinkSync(role.file);
  res.json({ ok: true });
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
    tasks: listAllTasks(200),
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

// Mark a message as approved in-place
app.post('/api/messages/:id/approve', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'invalid id' }); return; }
  approveMessage(id);
  res.json({ ok: true });
});

app.post('/api/messages/:id/select-option', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'invalid id' }); return; }
  const { option_index } = req.body as { option_index: number };
  selectOption(id, option_index);
  res.json({ ok: true });
});

// Purge stale ended agents that have no real history
app.post('/api/agents/purge', (_req: Request, res: Response) => {
  const count = purgeStaleAgents();
  res.json({ ok: true, purged: count });
});

// ── Eval pipeline endpoints ────────────────────────────────────────────────────

app.get('/api/eval/report', (_req: Request, res: Response) => {
  const reportPath = join(process.cwd(), 'tests', 'eval_report.json');
  if (!existsSync(reportPath)) { res.json([]); return; }
  res.json(JSON.parse(readFileSync(reportPath, 'utf8')));
});

app.get('/api/eval/gate', (_req: Request, res: Response) => {
  const gateDir = join(process.cwd(), 'tests', 'gate_results');
  if (!existsSync(gateDir)) { res.json([]); return; }
  const results = readdirSync(gateDir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(gateDir, f), 'utf8')));
  res.json(results);
});

app.post('/api/eval/run', (_req: Request, res: Response) => {
  const indexJs = join(__dirname, '..', 'index.js');
  const child = spawn(process.execPath, [indexJs, 'eval', '--critic', '--gate'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
  res.json({ ok: true, message: 'Improvement loop started' });
});

app.get('/api/eval/results', (req: Request, res: Response) => {
  const taskId = parseInt(String(req.query.task_id), 10);
  if (isNaN(taskId)) { res.status(400).json({ error: 'task_id required' }); return; }
  res.json(getEvalResults(taskId));
});

app.get('/api/eval/counts', (_req: Request, res: Response) => {
  res.json(getMetricFailureCounts());
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

// Kill a worker agent without respawning
app.post('/api/agents/:agentId/kill', (req: Request, res: Response) => {
  const agentId = String(req.params.agentId);
  const agent = getAgentById(agentId);

  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }
  if (agent.slot === 0) { res.status(400).json({ error: 'Cannot kill the orchestrator (slot 0)' }); return; }
  if (agent.ended_at !== null) { res.status(409).json({ error: 'Agent is already ended' }); return; }
  if (!agent.tmux_pane) { res.status(409).json({ error: 'Agent has no tmux pane — cannot kill it' }); return; }

  try {
    execSync(`tmux kill-pane -t ${agent.tmux_pane}`);
  } catch (e) {
    process.stderr.write(`[Synapse] kill: kill-pane failed for ${agent.tmux_pane}: ${e}\n`);
  }

  markAgentEnded(agentId);
  reapGhostAgents();
  purgeStaleAgents();

  res.json({ ok: true });
});

// Return boot_task + role body + protocol docs for the agent system prompt modal
app.get('/api/agents/:agentId/prompt', (req: Request, res: Response) => {
  const agentId = String(req.params.agentId);
  const agent = getAgentById(agentId);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

  let roleBody: string | null = null;
  if (agent.role) {
    const rolePath = join(ROLES_DIR, `${agent.role}.md`);
    if (existsSync(rolePath)) {
      const raw = readFileSync(rolePath, 'utf8');
      // Strip front-matter so only the body text is returned
      roleBody = raw.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
    }
  }

  const synapseDir = join(process.cwd(), '.synapse');
  const baseProtocolPath = join(synapseDir, 'SYNAPSE.md');
  const slotDocPath = agent.slot === 0
    ? join(synapseDir, 'SYNAPSE-orchestrator.md')
    : join(synapseDir, 'SYNAPSE-worker.md');

  const baseProtocol = existsSync(baseProtocolPath)
    ? readFileSync(baseProtocolPath, 'utf8').trim()
    : null;
  const slotDoc = existsSync(slotDocPath)
    ? readFileSync(slotDocPath, 'utf8').trim()
    : null;

  res.json({
    boot_task: agent.boot_task ?? null,
    role: agent.role ?? null,
    role_body: roleBody,
    base_protocol: baseProtocol,
    slot_doc: slotDoc,
  });
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

// Git diff for a commit SHA
app.get('/api/commit/:sha/diff', (req: Request, res: Response) => {
  const sha = String(req.params.sha);
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    res.status(400).json({ error: 'invalid sha' });
    return;
  }
  try {
    const diff = execSync(`git show --stat -p ${sha}`, { encoding: 'utf8' });
    const subject = execSync(`git log -1 --format=%s ${sha}`, { encoding: 'utf8' }).trim();
    res.json({ sha, subject, diff });
  } catch {
    res.status(404).json({ error: 'commit not found' });
  }
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
    tasks: listAllTasks(200),
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
