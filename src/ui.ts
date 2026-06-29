import { connect, MESSAGE_TYPES } from "./commands";

// ---------- ui ----------

const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synapse</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #1a1a1a; --bg2: #242424; --bg3: #2e2e2e; --border: #3a3a3a;
    --text: #e0e0e0; --text-muted: #888;
    --green: #4caf50; --yellow: #ffc107; --blue: #2196f3; --gray: #757575; --red: #f44336;
  }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: monospace; font-size: 13px; }
  body { display: flex; flex-direction: column; }
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 16px; background: var(--bg2); border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  header .title { font-size: 15px; font-weight: bold; letter-spacing: 1px; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; background: var(--gray); }
  .status-dot.connected { background: var(--green); }
  .status-label { color: var(--text-muted); font-size: 12px; }
  .main { display: flex; flex: 1; min-height: 0; }
  .panel-agents { width: 220px; flex-shrink: 0; border-right: 1px solid var(--border); display: flex; flex-direction: column; }
  .panel-header { padding: 6px 10px; background: var(--bg3); border-bottom: 1px solid var(--border); font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; }
  .panel-header-row { display: flex; align-items: center; justify-content: space-between; }
  #agent-table { flex: 1; overflow-y: auto; }
  .agent-row { display: flex; align-items: center; gap: 6px; padding: 5px 10px; border-bottom: 1px solid var(--border); }
  .agent-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .agent-dot.idle { background: var(--green); }
  .agent-dot.busy { background: var(--yellow); }
  .agent-dot.stopped, .agent-dot.unknown { background: var(--gray); }
  .agent-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agent-role { color: var(--text-muted); font-size: 11px; }
  .agent-pending { background: var(--yellow); color: #000; font-size: 10px; padding: 0 4px; border-radius: 8px; line-height: 16px; flex-shrink: 0; }
  .panel-messages { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #msg-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }
  .msg-row { padding: 5px 12px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; align-items: flex-start; line-height: 1.4; }
  .msg-meta { display: flex; gap: 6px; flex-shrink: 0; align-items: baseline; flex-wrap: wrap; }
  .msg-id { color: var(--text-muted); font-size: 11px; min-width: 30px; }
  .msg-route { color: var(--text-muted); font-size: 11px; white-space: nowrap; }
  .msg-type { font-size: 11px; font-weight: bold; padding: 0 5px; border-radius: 3px; line-height: 16px; flex-shrink: 0; }
  .msg-type.TASK   { background: #1a3a5c; color: #64b5f6; }
  .msg-type.STATUS { background: #1a3d1a; color: #81c784; }
  .msg-type.REVIEW { background: #3d2e00; color: #ffd54f; }
  .msg-type.ACK, .msg-type.INFO { background: #2e2e2e; color: #aaa; }
  .msg-status { font-size: 10px; color: var(--text-muted); flex-shrink: 0; }
  .msg-body { flex: 1; word-break: break-word; color: var(--text); white-space: pre-wrap; }
  .msg-time { font-size: 10px; color: var(--text-muted); flex-shrink: 0; white-space: nowrap; }
  .send-bar { flex-shrink: 0; border-top: 1px solid var(--border); background: var(--bg2); padding: 8px 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .send-bar label { color: var(--text-muted); font-size: 12px; }
  .send-bar select, .send-bar input[type=text] { background: var(--bg3); border: 1px solid var(--border); color: var(--text); font-family: monospace; font-size: 13px; padding: 4px 8px; border-radius: 3px; outline: none; }
  .send-bar select:focus, .send-bar input:focus { border-color: #555; }
  #input-to   { width: 120px; }
  #input-type { width: 90px; }
  #input-body { flex: 1; min-width: 180px; }
  .send-bar button { background: #2a4a6a; color: #90caf9; border: 1px solid #3a5a8a; font-family: monospace; font-size: 13px; padding: 4px 14px; border-radius: 3px; cursor: pointer; white-space: nowrap; }
  .send-bar button:hover { background: #2d527a; }
  .send-bar button:disabled { opacity: 0.5; cursor: default; }
  .send-error { color: var(--red); font-size: 12px; }
  .send-ok    { color: var(--green); font-size: 12px; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
</style>
</head>
<body>
<header>
  <span class="title">Synapse</span>
  <span>
    <span class="status-dot" id="sse-dot"></span>
    <span class="status-label" id="sse-label">connecting…</span>
  </span>
</header>
<div class="main">
  <div class="panel-agents">
    <div class="panel-header">Agents</div>
    <div id="agent-table"><div class="agent-row" style="color:var(--text-muted)">loading…</div></div>
  </div>
  <div class="panel-messages">
    <div class="panel-header panel-header-row">
      <span>Messages</span>
      <span id="msg-count" style="color:var(--text-muted)">0</span>
    </div>
    <div id="msg-list"></div>
    <div class="send-bar">
      <label>To:</label>
      <select id="input-to"></select>
      <label>Type:</label>
      <select id="input-type">
        <option>TASK</option><option>STATUS</option><option>REVIEW</option><option>ACK</option><option>INFO</option>
      </select>
      <input type="text" id="input-body" placeholder="message body… (Ctrl+Enter to send)" autocomplete="off">
      <button id="send-btn">Send</button>
      <span id="send-feedback"></span>
    </div>
  </div>
</div>
<script>
(function () {
  const $ = id => document.getElementById(id);
  const agentTable = $('agent-table'), msgList = $('msg-list');
  const sseDot = $('sse-dot'), sseLabel = $('sse-label');
  const inputTo = $('input-to'), inputType = $('input-type'), inputBody = $('input-body');
  const sendBtn = $('send-btn'), feedback = $('send-feedback'), msgCount = $('msg-count');
  let totalMsgs = 0, knownAgents = [];

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function fmtTime(ts) {
    try {
      const d = new Date(ts.endsWith('Z') ? ts : ts + 'Z');
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { return ts; }
  }
  function flash(msg, ok) {
    feedback.className = ok ? 'send-ok' : 'send-error';
    feedback.textContent = msg;
    setTimeout(() => { feedback.textContent = ''; }, 3000);
  }

  function renderAgents(agents) {
    knownAgents = agents;
    const cur = inputTo.value;
    inputTo.innerHTML = '<option value="broadcast">broadcast</option>' +
      agents.map(a => '<option value="' + esc(a.window_name) + '">' + esc(a.window_name) + '</option>').join('');
    if (cur) inputTo.value = cur;

    if (!agents.length) {
      agentTable.innerHTML = '<div class="agent-row" style="color:var(--text-muted)">no agents</div>';
      return;
    }
    agentTable.innerHTML = agents.map(a => {
      const st = (a.status || 'unknown').toLowerCase();
      const dotCls = ['idle','busy','stopped'].includes(st) ? st : 'unknown';
      const badge = a.pending_count > 0 ? '<span class="agent-pending">' + a.pending_count + '</span>' : '';
      return '<div class="agent-row"><span class="agent-dot ' + dotCls + '"></span>' +
        '<span class="agent-name" title="' + esc(a.window_name) + '">' + esc(a.window_name) + '</span>' +
        '<span class="agent-role">' + esc(a.role || '') + '</span>' + badge + '</div>';
    }).join('');
  }

  function appendMessage(msg) {
    totalMsgs++;
    msgCount.textContent = totalMsgs;
    const t = (msg.type || '').toUpperCase();
    const row = document.createElement('div');
    row.className = 'msg-row';
    row.innerHTML =
      '<span class="msg-meta">' +
        '<span class="msg-id">#' + msg.id + '</span>' +
        '<span class="msg-route">' + esc(msg.from_agent) + ' → ' + esc(msg.to_agent) + '</span>' +
        '<span class="msg-type ' + esc(t) + '">' + esc(t) + '</span>' +
        (msg.status ? '<span class="msg-status">' + esc(msg.status) + '</span>' : '') +
      '</span>' +
      '<span class="msg-body">' + esc(msg.body || '') + '</span>' +
      '<span class="msg-time">' + fmtTime(msg.created_at || '') + '</span>';
    msgList.insertBefore(row, msgList.firstChild);
  }

  function connect() {
    const es = new EventSource('/events');
    es.addEventListener('agent-status', e => { try { renderAgents(JSON.parse(e.data)); } catch {} });
    es.addEventListener('message-stream', e => { try { appendMessage(JSON.parse(e.data)); } catch {} });
    es.onopen = () => { sseDot.className = 'status-dot connected'; sseLabel.textContent = 'connected'; };
    es.onerror = () => { sseDot.className = 'status-dot'; sseLabel.textContent = 'reconnecting…'; es.close(); setTimeout(connect, 2000); };
  }
  connect();

  async function sendMessage() {
    const to = inputTo.value.trim(), type = inputType.value, body = inputBody.value.trim();
    if (!to || !body) { flash('To and body required', false); return; }
    sendBtn.disabled = true; feedback.textContent = '';
    try {
      const res = await fetch('/send', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({to, type, body}) });
      const json = await res.json();
      if (json.ok) { inputBody.value = ''; flash('sent #' + json.id, true); }
      else flash(json.error || 'error', false);
    } catch (err) { flash(String(err), false); }
    finally { sendBtn.disabled = false; }
  }

  sendBtn.addEventListener('click', sendMessage);
  inputBody.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendMessage(); });
})();
</script>
</body>
</html>`;

const DEFAULT_UI_PORT = 7700;

export function cmdUi(flags: Record<string, string>) {
  const port = flags["port"] ? parseInt(flags["port"], 10) : DEFAULT_UI_PORT;
  const db = connect();

  let lastMessageId = 0;
  // Seed last_id to current max so we only push new messages after startup.
  const maxRow = db
    .query("SELECT MAX(id) AS max_id FROM messages")
    .get() as any;
  if (maxRow?.max_id) lastMessageId = maxRow.max_id;

  // SSE client registry
  const clients = new Set<ReadableStreamDefaultController>();

  function pushToAll(eventName: string, data: unknown) {
    const chunk = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const ctrl of clients) {
      try {
        ctrl.enqueue(chunk);
      } catch {
        clients.delete(ctrl);
      }
    }
  }

  function pollDb() {
    // Agent status snapshot
    const agents = db
      .query(
        `SELECT window_name, role, status, last_seen_at,
                (SELECT COUNT(*) FROM messages m
                 WHERE m.status='pending'
                   AND (m.to_agent=a.window_name OR m.to_agent='broadcast')) AS pending_count
         FROM agents a
         ORDER BY role, window_name`,
      )
      .all();
    pushToAll("agent-status", agents);

    // New messages since last push
    const newMessages = db
      .query(
        `SELECT id, from_agent, to_agent, type, body, status, created_at
         FROM messages WHERE id > ? ORDER BY id`,
      )
      .all(lastMessageId) as any[];
    if (newMessages.length > 0) {
      lastMessageId = newMessages[newMessages.length - 1].id;
      for (const msg of newMessages) {
        pushToAll("message-stream", msg);
      }
    }
  }

  const pollTimer = setInterval(pollDb, 1000);

  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/" && req.method === "GET") {
        return new Response(FRONTEND_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/events" && req.method === "GET") {
        let ctrl: ReadableStreamDefaultController;
        const stream = new ReadableStream({
          start(c) {
            ctrl = c;
            clients.add(ctrl);
            // Send initial snapshot immediately
            pollDb();
          },
          cancel() {
            clients.delete(ctrl);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      if (url.pathname === "/send" && req.method === "POST") {
        return req
          .json()
          .then((body: any) => {
            const { to, type, body: msgBody } = body ?? {};
            if (!to || !type || !msgBody) {
              return Response.json(
                { ok: false, error: "missing to, type, or body" },
                { status: 400 },
              );
            }
            if (!MESSAGE_TYPES.has(type)) {
              return Response.json(
                {
                  ok: false,
                  error: `type must be one of ${[...MESSAGE_TYPES].sort()}`,
                },
                { status: 400 },
              );
            }
            if (to !== "broadcast") {
              const known = db
                .query("SELECT 1 FROM agents WHERE window_name=?")
                .get(to);
              if (!known) {
                console.error(
                  `synapse ui: warning — '${to}' not in agents registry (sending anyway)`,
                );
              }
            }
            const result = db.run(
              `INSERT INTO messages (from_agent, to_agent, type, body) VALUES ('ui', ?, ?, ?)`,
              [to, type, msgBody],
            );
            return Response.json({
              ok: true,
              id: Number(result.lastInsertRowid),
            });
          })
          .catch(() =>
            Response.json(
              { ok: false, error: "invalid JSON" },
              { status: 400 },
            ),
          );
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  const shutdown = () => {
    clearInterval(pollTimer);
    for (const ctrl of clients) {
      try {
        ctrl.close();
      } catch {}
    }
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`synapse ui: listening on http://localhost:${port}`);
  console.log(`  GET  /        — dashboard`);
  console.log(`  GET  /events  — SSE stream (agent-status, message-stream)`);
  console.log(`  POST /send    — {to, type, body}`);
}
