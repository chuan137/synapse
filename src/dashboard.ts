import express, { Request, Response } from 'express';
import { join, dirname, basename, resolve, sep, extname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, statSync, watchFile, writeFileSync, unlinkSync, readdirSync, mkdirSync, realpathSync, openSync, readSync, closeSync } from 'fs';
import { execSync, execFileSync, spawnSync, spawn } from 'child_process';
import { parseRoleFile, serializeRoleFile, isValidRoleName, Role } from './roles.js';
import { buildSystemPrompt } from './system-prompt.js';
import { Nudger } from './nudge.js';
import { HealthMonitor } from './health-monitor.js';
import { resolveFamily, isFamily } from './models.js';
import {
  db,
  DB_PATH,
  getAllStatuses,
  getRecentMessages,
  sendMessage,
  approveMessage,
  selectOption,
  getTmuxPane,
  getPendingApprovals,
  resolveApproval,
  getRecentEvents,
  getAllToolMetrics,
  listAllTasks,
  purgeStaleAgents,
  reapGhostAgents,
  updateAgentConfig,
  getAgentById,
  markAgentEnded,
  getEvalResults,
  getAllEvalResults,
  getMetricFailureCounts,
  checkAndResetMetricThreshold,
  resetMetricCount,
  AgentStatus,
  Message,
  ApprovalRequest,
} from './db.js';
import { spawnWorker } from './spawn.js';

type AugmentedStatus = AgentStatus & {
  over_threshold:      boolean;
  orch_over_threshold: boolean;
  orch_idle_blocked:   boolean;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.SYNAPSE_PORT ?? '4000', 10);
const ROLES_DIR = join(__dirname, '..', 'templates', 'roles');
// Derive the git root from the DB path so git commands work even when the
// dashboard was launched from a different directory (e.g. via SYNAPSE_DB_PATH).
// Using git rev-parse handles non-standard DB_PATH locations correctly.
let GIT_CWD: string;
try {
  GIT_CWD = execSync('git rev-parse --show-toplevel', { cwd: dirname(DB_PATH), encoding: 'utf8' }).trim();
} catch (err: any) {
  GIT_CWD = dirname(dirname(DB_PATH));
  const isNonGit = err?.status === 128 || String(err?.stderr ?? '').toLowerCase().includes('not a git repository');
  if (isNonGit) {
    console.info('[dashboard] DB_PATH outside a git repo; commit-hash features disabled');
  } else {
    console.warn('[dashboard] could not resolve git root from DB_PATH dir, falling back:', err?.message ?? err);
  }
}
const PROJECT_NAME = basename(GIT_CWD);

function readProjectId(): string | null {
  const p = join(GIT_CWD, '.synapse', 'settings.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')).projectId ?? null; } catch { return null; }
}

// ── progress.md file-watch ────────────────────────────────────────────────────

const PROGRESS_PATH = join(GIT_CWD, '.synapse', 'progress.md');

function readProgress(): { content: string; updated_at: number } {
  try {
    const content = readFileSync(PROGRESS_PATH, 'utf8');
    const updated_at = statSync(PROGRESS_PATH).mtimeMs;
    return { content, updated_at };
  } catch {
    return { content: '', updated_at: 0 };
  }
}

let currentPlan = readProgress();

// Use watchFile (stat-poll) — more reliable than fs.watch across editors/NFS.
watchFile(PROGRESS_PATH, { interval: 1500 }, () => {
  const next = readProgress();
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
  if (process.env.SYNAPSE_DEBUG && !req.path.startsWith('/events')) {
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
let lastStatuses     = '';
let lastMessages     = '';
let lastApprovals    = '';
let lastEvents       = '';
let lastTasks        = '';
let lastPlan         = '';
let lastWarnings     = '';
let lastOrchWarnings = '';
let lastOrchIdle     = '';

const nudger = new Nudger();
nudger.start(500);

const healthMonitor = new HealthMonitor({ deps: { pingAgent: (id) => nudger.pingAgent(id) } });
healthMonitor.start();

setInterval(() => {
  const statuses   = getAllStatuses();
  const messages   = getRecentMessages(200);
  const approvals  = getPendingApprovals();
  const events     = getRecentEvents(200);
  const metrics    = getAllToolMetrics();
  const tasks      = listAllTasks(200);

  const warnings     = healthMonitor.currentWarnings;
  const orchWarnings = healthMonitor.orchWarnings;
  const orchIdle     = healthMonitor.orchIdleBlocked;
  const augmentedStatuses: AugmentedStatus[] = statuses.map((s) => ({
    ...s,
    over_threshold:      warnings.has(s.agent_id),
    orch_over_threshold: orchWarnings.has(s.agent_id),
    orch_idle_blocked:   orchIdle.has(s.agent_id),
  }));

  const broadcastSettings = readSettings();
  const broadcastRestartHint  = typeof broadcastSettings.toolCallRestartHint === 'number' ? broadcastSettings.toolCallRestartHint : 200;
  const broadcastCompactHint  = typeof broadcastSettings.compactHint === 'number' ? broadcastSettings.compactHint : Math.floor(broadcastRestartHint / 2);

  const statusStr      = JSON.stringify(statuses);
  const msgStr         = JSON.stringify(messages.map((m) => m.id));
  const approvalStr    = JSON.stringify(approvals.map((a) => a.id));
  const eventStr       = JSON.stringify(events.map((e) => e.id));
  const taskStr        = JSON.stringify(tasks.map((a) => `${a.id}:${a.status}:${a.commit_sha}`));
  const planStr        = `${currentPlan.updated_at}`;
  const warningStr     = JSON.stringify([...warnings].sort());
  const orchWarningStr = JSON.stringify([...orchWarnings].sort());
  const orchIdleStr    = JSON.stringify([...orchIdle].sort());

  if (
    statusStr    !== lastStatuses  ||
    msgStr       !== lastMessages  ||
    approvalStr  !== lastApprovals ||
    eventStr     !== lastEvents    ||
    taskStr      !== lastTasks     ||
    planStr      !== lastPlan      ||
    warningStr   !== lastWarnings  ||
    orchWarningStr !== lastOrchWarnings ||
    orchIdleStr  !== lastOrchIdle
  ) {
    lastStatuses     = statusStr;
    lastMessages     = msgStr;
    lastApprovals    = approvalStr;
    lastEvents       = eventStr;
    lastTasks        = taskStr;
    lastPlan         = planStr;
    lastWarnings     = warningStr;
    lastOrchWarnings = orchWarningStr;
    lastOrchIdle     = orchIdleStr;
    broadcast({ statuses: augmentedStatuses, messages, approvals, events, metrics, tasks, plan: currentPlan, compactHint: broadcastCompactHint, toolCallRestartHint: broadcastRestartHint });
  }
}, 500);

// ── Routes ─────────────────────────────────────────────────────────────────

app.get('/api/info', (_req: Request, res: Response) => {
  res.json({ project: PROJECT_NAME, projectId: readProjectId() });
});

// ── Settings (theme, etc.) ────────────────────────────────────────────────────

const SETTINGS_PATH = join(GIT_CWD, '.synapse', 'settings.json');

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

app.post('/api/ping/:agentId', (req: Request, res: Response) => {
  const agentId = String(req.params.agentId);
  const ok = nudger.pingAgent(agentId);
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
  if (p === 0) nudger.pingAgent(to_id);
  res.json({ ok: true });
});

// Mark a message as approved in-place
app.post('/api/messages/:id/approve', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'invalid id' }); return; }
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
  approveMessage(id);
  if (msg) {
    sendMessage('human', msg.from_id, 'Approved.', 5, false, undefined, msg.task_id ?? null);
  }
  res.json({ ok: true });
});

app.post('/api/messages/:id/select-option', (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: 'invalid id' }); return; }
  const { option_index } = req.body as { option_index: number };
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
  selectOption(id, option_index);
  if (msg) {
    const options = msg.request_options ? JSON.parse(msg.request_options) : [];
    const chosen = options[option_index] ?? `option ${option_index}`;
    sendMessage('human', msg.from_id, chosen, 5, false, undefined, msg.task_id ?? null);
  }
  res.json({ ok: true });
});

// Purge stale ended agents that have no real history
app.post('/api/agents/purge', (_req: Request, res: Response) => {
  const count = purgeStaleAgents();
  res.json({ ok: true, purged: count });
});

// ── Eval pipeline endpoints ────────────────────────────────────────────────────

app.get('/api/eval/report', (_req: Request, res: Response) => {
  const reportPath = join(GIT_CWD, 'tests', 'eval_report.json');
  if (!existsSync(reportPath)) { res.json([]); return; }
  res.json(JSON.parse(readFileSync(reportPath, 'utf8')));
});

app.get('/api/eval/gate', (_req: Request, res: Response) => {
  const gateDir = join(GIT_CWD, 'tests', 'gate_results');
  if (!existsSync(gateDir)) { res.json([]); return; }
  const results = readdirSync(gateDir)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(gateDir, f), 'utf8')));
  res.json(results);
});

app.post('/api/eval/run', (_req: Request, res: Response) => {
  const indexJs = join(__dirname, 'index.js');
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

app.get('/api/eval/live', (_req: Request, res: Response) => {
  res.json(getAllEvalResults());
});

app.get('/api/eval/case', (req: Request, res: Response) => {
  const taskId = parseInt(String(req.query.task_id), 10);
  if (isNaN(taskId)) { res.status(400).json({ error: 'task_id required' }); return; }
  const evalDir = join(GIT_CWD, '.synapse', 'evaluations');
  const goodPath = join(evalDir, `task_${taskId}_good.json`);
  const badPath  = join(evalDir, `task_${taskId}_bad.json`);
  if (existsSync(goodPath)) { res.json(JSON.parse(readFileSync(goodPath, 'utf8'))); return; }
  if (existsSync(badPath))  { res.json(JSON.parse(readFileSync(badPath,  'utf8'))); return; }
  res.status(404).json({ error: 'No case file available' });
});

// ── Retros endpoints ───────────────────────────────────────────────────────

const RETROS_DIR = join(GIT_CWD, '.synapse', 'retros');

app.get('/api/retros', (_req: Request, res: Response) => {
  if (!existsSync(RETROS_DIR)) { res.json([]); return; }
  const files = readdirSync(RETROS_DIR).filter(f => f.endsWith('.md'));
  const retros = files.map(filename => {
    const stem = filename.replace(/\.md$/, '');
    // filename format: YYYYMMDD-HHmmss-<agent_id>.md  e.g. 20260609-223411-cec50b17-0.md
    const m = stem.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(.+)$/);
    let timestamp = 0;
    let agent_id = stem;
    if (m) {
      timestamp = Date.UTC(
        parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]),
        parseInt(m[4]), parseInt(m[5]), parseInt(m[6]),
      );
      // convert last dash in agent segment to colon: cec50b17-0 → cec50b17:0
      agent_id = m[7].replace(/-(\d+)$/, ':$1');
    }
    const body = readFileSync(join(RETROS_DIR, filename), 'utf8');
    const task_count = (body.match(/- \d+:/g) ?? []).length;
    const preview = body.split('\n').find(l => l.trim() && !l.startsWith('#'))?.trim().slice(0, 200) ?? '';
    return { filename, timestamp, agent_id, task_count, preview };
  }).sort((a, b) => b.timestamp - a.timestamp);
  res.json(retros);
});

app.get('/api/retros/:filename', (req: Request, res: Response) => {
  const filename = String(req.params['filename'] ?? '');
  if (!filename.endsWith('.md') || filename.includes('/') || filename.includes('..')) {
    res.status(400).json({ error: 'Invalid filename' }); return;
  }
  const filePath = join(RETROS_DIR, filename);
  if (!existsSync(filePath)) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ content: readFileSync(filePath, 'utf8') });
});

app.post('/api/retros/run', (_req: Request, res: Response) => {
  const orch = db.prepare<[], { agent_id: string }>(
    `SELECT agent_id FROM agent_status WHERE slot = 0 AND ended_at IS NULL LIMIT 1`
  ).get();
  if (!orch) { res.status(503).json({ error: 'No active orchestrator' }); return; }
  sendMessage('system', orch.agent_id, '[system] run /retro now', 5);
  res.json({ queued: true });
});

// ── Proposals endpoints ────────────────────────────────────────────────────

const PROPOSALS_DIR = join(GIT_CWD, '.synapse', 'proposals');

function parseProposalFile(filename: string, content: string): Record<string, unknown> {
  const get = (label: string) => {
    const m = content.match(new RegExp(`^##?\\s+${label}[:\\s]*\\n([\\s\\S]*?)(?=\\n##|$)`, 'im'));
    return m ? m[1].trim() : '';
  };
  const statusMatch = content.match(/^Status:\s*(.+)$/im);
  const targetMatch = content.match(/^Target-file:\s*(.+)$/im);
  const metricMatch = content.match(/^Trigger:\s*(\w+)/im) || filename.match(/\d+-(\w+)\.md/);
  const tsMatch = filename.match(/^(\d+)-/);
  return {
    filename,
    metric: metricMatch ? (Array.isArray(metricMatch) ? metricMatch[1] : metricMatch[1]) : '',
    timestamp: tsMatch ? new Date(parseInt(tsMatch[1])).toLocaleString() : '',
    status: statusMatch ? statusMatch[1].trim() : 'pending',
    rootCause: get('Root cause'),
    proposedChange: get('Proposed rule change'),
    targetFile: targetMatch ? targetMatch[1].trim() : '',
  };
}

app.get('/api/proposals', (_req: Request, res: Response) => {
  mkdirSync(PROPOSALS_DIR, { recursive: true });
  const files = readdirSync(PROPOSALS_DIR)
    .filter(f => f.endsWith('.md') && !f.startsWith('handover-') && !f.startsWith('gate-handover-'));
  const proposals = files.map(filename => {
    const content = readFileSync(join(PROPOSALS_DIR, filename), 'utf8');
    const parsed = parseProposalFile(filename, content);
    const verdictFile = filename.replace('.md', '.verdict.json');
    const verdictPath = join(PROPOSALS_DIR, verdictFile);
    const verdict = existsSync(verdictPath)
      ? JSON.parse(readFileSync(verdictPath, 'utf8'))
      : null;
    return { ...parsed, verdictFile, verdict };
  });
  res.json(proposals);
});

app.post('/api/proposals/generate', async (req: Request, res: Response) => {
  const { metric } = req.body as { metric: string };
  if (!metric) { res.status(400).json({ error: 'metric required' }); return; }

  const { spawnProposalSession } = await import('./eval/propose.js');
  const { getFailedTasksForMetric } = await import('./db.js');

  const failedIds = getFailedTasksForMetric(metric, 1);
  const triggerTaskId = failedIds[0] ?? 0;

  spawnProposalSession(triggerTaskId, metric);
  res.json({ ok: true, message: `Spawning proposal session for metric: ${metric}` });
});

app.post('/api/proposals/:filename/gate', (req: Request, res: Response) => {
  const filename = String(req.params.filename);
  const proposalPath = join(PROPOSALS_DIR, filename);
  if (!existsSync(proposalPath)) { res.status(404).json({ error: 'Proposal not found' }); return; }

  const proposalContent = readFileSync(proposalPath, 'utf8');
  const passingTasks = listAllTasks(200).filter((t: any) => t.status === 'completed' && !t.eval_failed).slice(0, 20);
  const passingSection = passingTasks.map((t: any) => {
    const evals = getEvalResults(t.id);
    const metrics = evals.map(e => `${e.metric}=${e.value ?? 'n/a'}`).join(', ');
    return `- Task #${t.id}: ${t.title.slice(0, 60)} [${metrics}]`;
  }).join('\n') || '(none recorded)';

  const tsMatch = filename.match(/^(\d+)-(\w+)\.md$/);
  const verdictPath = tsMatch
    ? join(PROPOSALS_DIR, `${tsMatch[1]}-${tsMatch[2]}.verdict.json`)
    : join(PROPOSALS_DIR, filename.replace('.md', '.verdict.json'));

  const handoverContent = `# Gate Evaluation Request

You are a Synapse protocol gate evaluator.

## Proposal to evaluate
${proposalContent}

## Passing trajectories (check for regression — last 20 tasks with all metrics passing):
${passingSection}

## Instructions
Evaluate this proposal on 3 criteria:
1. regression_prevented: Would this rule change have prevented the 3 listed failures?
2. regression_free: Does it risk causing any of the 20 passing tasks to fail?
3. size_ok: Does it stay within 2 added/modified rule sentences?

Write your verdict ONLY to \`${verdictPath}\`:
{
  "regression_prevented": true/false,
  "regression_free": true/false,
  "size_ok": true/false,
  "deploy_recommended": true/false,
  "notes": "..."
}

Do not modify any other files.
`;

  const handoverPath = join(PROPOSALS_DIR, `gate-handover-${filename}`);
  writeFileSync(handoverPath, handoverContent, 'utf8');

  const child = spawn('claude', ['--print', '--dangerously-skip-permissions', handoverPath], {
    detached: true,
    stdio: 'ignore',
    cwd: GIT_CWD,
    env: { ...process.env },
  });
  child.unref();
  res.json({ ok: true });
});

app.post('/api/proposals/:filename/regenerate', async (req: Request, res: Response) => {
  const filename = String(req.params.filename);
  const metricMatch = filename.match(/^\d+-(\w+)\.md$/);
  if (!metricMatch) { res.status(400).json({ error: 'Cannot parse metric from filename' }); return; }
  const metric = metricMatch[1];
  const tsMatch = filename.match(/^(\d+)-/);
  const triggerTaskId = tsMatch ? parseInt(tsMatch[1], 10) : 0;
  resetMetricCount(metric);
  try {
    const { spawnProposalSession } = await import('./eval/propose.js');
    await spawnProposalSession(triggerTaskId, metric);
  } catch (e) {
    res.status(500).json({ error: String(e) }); return;
  }
  res.json({ ok: true });
});

app.post('/api/proposals/:filename/deploy', (req: Request, res: Response) => {
  const filename = String(req.params.filename);
  const proposalPath = join(PROPOSALS_DIR, filename);
  if (!existsSync(proposalPath)) { res.status(404).json({ error: 'Proposal not found' }); return; }

  let content = readFileSync(proposalPath, 'utf8');
  const targetMatch = content.match(/^Target-file:\s*(.+)$/im);
  const changeMatch = content.match(/^##\s*Proposed rule change\s*\n([\s\S]*?)(?=\n##|$)/im);
  const metricMatch = filename.match(/^\d+-(\w+)\.md$/);

  if (!targetMatch) { res.status(400).json({ error: 'No Target-file in proposal' }); return; }
  const targetFile = join(GIT_CWD, targetMatch[1].trim());
  const proposedChange = changeMatch ? changeMatch[1].trim() : '';

  if (proposedChange && existsSync(targetFile)) {
    const existing = readFileSync(targetFile, 'utf8');
    writeFileSync(targetFile, existing.trimEnd() + '\n\n' + proposedChange + '\n', 'utf8');
  }

  try {
    execSync('synapse update .', { cwd: GIT_CWD, stdio: 'pipe' });
  } catch { /* best-effort */ }

  try {
    execFileSync('git', ['add', targetFile], { cwd: GIT_CWD, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', `deploy proposal: ${filename}`], { cwd: GIT_CWD, stdio: 'pipe' });
  } catch { /* best-effort if nothing staged */ }

  if (metricMatch) {
    resetMetricCount(metricMatch[1]);
  }

  content = content.replace(/^Status:\s*.+$/im, 'Status: deployed');
  writeFileSync(proposalPath, content, 'utf8');
  res.json({ ok: true });
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

  const dbPath = process.env.SYNAPSE_DB_PATH ?? join(GIT_CWD, '.synapse', 'synapse.db');
  const workerRole = role ?? 'worker';
  const settings = readSettings();
  const AUTO_RESTART_AFTER_TASKS = typeof settings.autoRestartTasks === 'number' ? settings.autoRestartTasks : 5;

  // Fetch last DONE message for this agent to use as handover context
  const lastDone = db.prepare(
    `SELECT content FROM messages WHERE from_id = ? AND content LIKE 'DONE%' ORDER BY created_at DESC LIMIT 1`
  ).get(agentId) as { content: string } | null;

  const handover = lastDone
    ? `\nLast completed task context:\n${lastDone.content.slice(0, 500)}`
    : '';

  const bootPath = existsSync(join(GIT_CWD, '.synapse', 'boot-worker-restart.md'))
    ? join(GIT_CWD, '.synapse', 'boot-worker-restart.md')
    : join(__dirname, '..', 'templates', 'boot-worker-restart.md');
  const restartTemplate = readFileSync(bootPath, 'utf8').trim();
  const orchestratorId = agent.orchestrator_id ?? `${agentId.split(':')[0]}:0`;
  const restartTask = restartTemplate
    .replace('{role}', workerRole)
    .replace('{autoRestartTasks}', String(AUTO_RESTART_AFTER_TASKS))
    .replace('{orchestratorId}', orchestratorId)
    .replace('{slot}', String(slot))
    .replace('{handover}', handover);

  const worker = spawnWorker({
    role: workerRole,
    name: name ?? undefined,
    task: restartTask,
    projectDir: GIT_CWD,
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

// Return boot_task + resolved system prompt for the agent system prompt modal
app.get('/api/agents/:agentId/prompt', (req: Request, res: Response) => {
  const agentId = String(req.params.agentId);
  const agent = getAgentById(agentId);
  if (!agent) { res.status(404).json({ error: 'Agent not found' }); return; }

  const role = agent.role ?? (agent.slot === 0 ? 'orchestrator' : 'worker');
  const resolved = buildSystemPrompt(role);

  res.json({
    boot_task: agent.boot_task ?? null,
    role: agent.role ?? null,
    resolved_prompt: resolved,
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
  // Family names ('opus'/'sonnet'/'haiku') are resolved to a concrete id first,
  // since older Claude Code versions don't accept family aliases at /model.
  if (fields.model) {
    const pane = getTmuxPane(agentId);
    if (pane) {
      const sendModel = isFamily(fields.model)
        ? resolveFamily(fields.model, GIT_CWD).model
        : fields.model;
      try {
        execFileSync('tmux', ['send-keys', '-t', pane, `/model ${sendModel}`, 'Enter']);
        // Brief pause for the confirmation prompt to appear, then confirm option 1.
        setTimeout(() => {
          try { execFileSync('tmux', ['send-keys', '-t', pane, '1', 'Enter']); } catch { /* best-effort */ }
        }, 800);
        process.stderr.write(`[Synapse] sent /model ${sendModel} to pane ${pane}\n`);
      } catch { /* best-effort — agent may not be at a prompt */ }
    }
  }

  res.json({ ok: true });
});

// File upload — saves to .synapse/uploads/ and returns the relative path
app.post('/api/upload', (req: Request, res: Response) => {
  const contentType = req.headers['content-type'] ?? '';
  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) {
    res.status(400).json({ error: 'expected multipart/form-data' });
    return;
  }
  const boundary = boundaryMatch[1];
  const uploadsDir = join(GIT_CWD, '.synapse', 'uploads');
  mkdirSync(uploadsDir, { recursive: true });

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    try {
      const body = Buffer.concat(chunks);
      // Find the Content-Disposition header to extract filename
      const bodyStr = body.toString('binary');
      const headerEnd = bodyStr.indexOf('\r\n\r\n');
      if (headerEnd === -1) { res.status(400).json({ error: 'malformed part' }); return; }
      const headerSection = bodyStr.slice(0, headerEnd);
      const nameMatch = headerSection.match(/filename="([^"]+)"/i);
      if (!nameMatch) { res.status(400).json({ error: 'no filename in upload' }); return; }

      // Sanitize: strip path separators, null bytes, and non-printable chars
      const rawName = nameMatch[1];
      const safeName = rawName.replace(/[/\\]/g, '').replace(/\.\./g, '').replace(/[^\x20-\x7e]/g, '').trim() || 'upload';

      // Extract file content: between \r\n\r\n after headers and before trailing boundary
      const partStart = headerEnd + 4; // skip \r\n\r\n
      const trailingBoundary = Buffer.from(`\r\n--${boundary}`);
      let partEnd = body.length;
      for (let i = partStart; i <= body.length - trailingBoundary.length; i++) {
        if (body.slice(i, i + trailingBoundary.length).equals(trailingBoundary)) {
          partEnd = i;
          break;
        }
      }
      const fileData = body.slice(partStart, partEnd);
      const filename = `${Date.now()}-${safeName}`;
      writeFileSync(join(uploadsDir, filename), fileData);
      const relativePath = `.synapse/uploads/${filename}`;
      res.json({ path: relativePath });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });
  req.on('error', (e) => res.status(500).json({ error: String(e) }));
});

// Git diff for a commit SHA
app.get('/api/commit/:sha/diff', (req: Request, res: Response) => {
  const sha = String(req.params.sha);
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    res.status(400).json({ error: 'invalid sha' });
    return;
  }
  // Look up the directory where this commit was made, fall back to GIT_CWD.
  const row = db.prepare<[string], { commit_cwd: string | null }>(
    `SELECT commit_cwd FROM tasks WHERE commit_sha = ? LIMIT 1`
  ).get(sha);
  let repoCwd = GIT_CWD;
  if (row?.commit_cwd && existsSync(row.commit_cwd) && existsSync(join(row.commit_cwd, '.git'))) {
    repoCwd = row.commit_cwd;
  }
  try {
    const diff = execFileSync('git', ['show', '--stat', '-p', sha], { encoding: 'utf8', cwd: repoCwd });
    const subject = execFileSync('git', ['log', '-1', '--format=%s', sha], { encoding: 'utf8', cwd: repoCwd }).trim();
    res.json({ sha, subject, diff, repo_cwd: repoCwd });
  } catch {
    res.status(404).json({ error: 'commit not found' });
  }
});

// File viewer — read-only, scoped to GIT_CWD, 1 MB cap
const FILE_MIME: Record<string, string> = {
  '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.ts': 'text/typescript', '.tsx': 'text/typescript',
  '.js': 'text/javascript', '.jsx': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css', '.html': 'text/html', '.htm': 'text/html',
  '.py': 'text/x-python', '.rb': 'text/x-ruby', '.go': 'text/x-go',
  '.sh': 'text/x-sh', '.bash': 'text/x-sh', '.zsh': 'text/x-sh',
  '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'text/toml',
  '.txt': 'text/plain', '.log': 'text/plain', '.env': 'text/plain',
};
const FILE_MAX_BYTES = 1_048_576; // 1 MB

app.get('/api/file', (req: Request, res: Response) => {
  const rel = String(req.query.path ?? '');
  if (!rel) { res.status(400).json({ error: 'path required' }); return; }

  const abs = resolve(GIT_CWD, rel);
  // Lexical path-traversal check
  if (!abs.startsWith(GIT_CWD + sep) && abs !== GIT_CWD) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  // H1: dereference symlinks and re-validate so in-tree symlinks pointing
  // outside the project are rejected.
  let realAbs: string;
  try { realAbs = realpathSync(abs); } catch { res.status(404).json({ error: 'not found' }); return; }
  if (!realAbs.startsWith(GIT_CWD + sep) && realAbs !== GIT_CWD) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  let stat: ReturnType<typeof statSync>;
  try { stat = statSync(realAbs); } catch { res.status(404).json({ error: 'not found' }); return; }
  if (!stat.isFile()) { res.status(404).json({ error: 'not a file' }); return; }

  const ext = extname(realAbs).toLowerCase();
  const mime = FILE_MIME[ext] ?? 'text/plain';
  const sizeBytes = stat.size;

  if (sizeBytes > FILE_MAX_BYTES) {
    res.json({ path: rel, truncated: true, sizeBytes, mime });
    return;
  }

  // M1: detect binary by sampling first 512 bytes for null bytes
  try {
    const SAMPLE = 512;
    const buf = Buffer.allocUnsafe(Math.min(SAMPLE, sizeBytes));
    const fd = openSync(realAbs, 'r');
    const bytesRead = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    if (buf.slice(0, bytesRead).includes(0x00)) {
      res.json({ path: rel, binary: true, sizeBytes, mime });
      return;
    }
  } catch {
    res.status(500).json({ error: 'read failed' });
    return;
  }

  try {
    const content = readFileSync(realAbs, 'utf8');
    res.json({ path: rel, absPath: realAbs, content, mime, sizeBytes });
  } catch {
    res.status(500).json({ error: 'read failed' });
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
