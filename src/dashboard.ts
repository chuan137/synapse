import express, { Request, Response } from 'express';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getAllStatuses,
  getRecentMessages,
  sendMessage,
  AgentStatus,
  Message,
} from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.SYNAPSE_PORT ?? '4000', 10);

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
let lastStatuses = '';
let lastMessages = '';

setInterval(() => {
  const statuses = getAllStatuses();
  const messages = getRecentMessages(200);

  const statusStr = JSON.stringify(statuses);
  const msgStr = JSON.stringify(messages.map((m) => m.id));

  if (statusStr !== lastStatuses || msgStr !== lastMessages) {
    lastStatuses = statusStr;
    lastMessages = msgStr;
    broadcast({ statuses, messages });
  }
}, 500);

// ── Routes ─────────────────────────────────────────────────────────────────

// Initial state snapshot
app.get('/api/state', (_req: Request, res: Response) => {
  res.json({
    statuses: getAllStatuses(),
    messages: getRecentMessages(200),
  });
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

  sendMessage('human', to_id, content, priority ?? 5);
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
