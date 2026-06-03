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

setInterval(() => {
  const statuses  = getAllStatuses();
  const messages  = getRecentMessages(200);
  const approvals = getPendingApprovals();

  const statusStr   = JSON.stringify(statuses);
  const msgStr      = JSON.stringify(messages.map((m) => m.id));
  const approvalStr = JSON.stringify(approvals.map((a) => a.id));

  if (statusStr !== lastStatuses || msgStr !== lastMessages || approvalStr !== lastApprovals) {
    lastStatuses  = statusStr;
    lastMessages  = msgStr;
    lastApprovals = approvalStr;
    broadcast({ statuses, messages, approvals });
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

// Initial state snapshot
app.get('/api/state', (_req: Request, res: Response) => {
  res.json({
    statuses: getAllStatuses(),
    messages: getRecentMessages(200),
    approvals: getPendingApprovals(),
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
  });
  res.write(`data: ${initial}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

export function startDashboard(port = PORT): Promise<number> {
  return new Promise((resolve) => {
    const srv = app.listen(port, () => {
      const addr = srv.address() as { port: number };
      process.stderr.write(`S-Deck running at http://localhost:${addr.port}\n`);
      resolve(addr.port);
    });
  });
}

// Allow direct invocation: `node dist/dashboard.js`
if (process.argv[1]?.endsWith('dashboard.js') || process.argv[1]?.endsWith('dashboard.ts')) {
  startDashboard();
}
