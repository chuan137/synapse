#!/usr/bin/env node
/**
 * stub-mcp-server.mjs — pre-compiled stub MCP server (plain ESM, no tsx).
 * Faster startup than tsx version.
 */

import * as fs from 'fs';

const QUEUE_FILE    = process.env.STUB_QUEUE_FILE    ?? '/tmp/stub-queue.json';
const OUTBOUND_FILE = process.env.STUB_OUTBOUND_FILE ?? '/tmp/stub-outbound.log';

function log(msg) {
  process.stderr.write(`[stub-mcp] ${msg}\n`);
}
function appendOutbound(line) {
  try { fs.appendFileSync(OUTBOUND_FILE, line + '\n', 'utf8'); } catch {}
}
function readQueue() {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const raw = fs.readFileSync(QUEUE_FILE, 'utf8').trim();
    if (!raw) return [];
    const msgs = JSON.parse(raw);
    fs.writeFileSync(QUEUE_FILE, '[]', 'utf8');
    return Array.isArray(msgs) ? msgs : [];
  } catch { return []; }
}

function handleTool(toolName, input) {
  log(`  tool: ${toolName}  input=${JSON.stringify(input).slice(0, 100)}`);

  if (toolName === 'read_messages') {
    const msgs = readQueue();
    const result = msgs.length > 0 ? msgs
      : [{ id: 0, from: 'system', content: 'No new messages.\n\n[Synapse] Now call update_status to report your current state.', priority: 5, at: new Date().toISOString() }];
    appendOutbound(`[inbound_read] drained ${msgs.length} messages`);
    return JSON.stringify(result, null, 2);
  }
  if (toolName === 'update_status') {
    const state = input.state ?? '?';
    const task  = input.current_task ?? '';
    const line  = `[outbound] update_status state=${state}${task ? ' task=' + JSON.stringify(task) : ''}`;
    log(line); appendOutbound(line);
    return `Status updated: ${state}${task ? ' — ' + task : ''}.`;
  }
  if (toolName === 'send_message') {
    const to = input.to_id ?? 'unknown';
    const content = String(input.content ?? '');
    const line = `[outbound] send_message to=${to} type=${input.type ?? 'message'} content=${JSON.stringify(content.slice(0, 120))}`;
    log(line); appendOutbound(line);
    return JSON.stringify({ ok: true, message_id: Math.floor(Math.random() * 9000) + 1000 });
  }
  if (toolName === 'report_done') {
    const line = `[outbound] report_done orchestrator=${input.orchestrator_id ?? '?'} content=${JSON.stringify(String(input.content ?? '').slice(0, 120))}`;
    log(line); appendOutbound(line);
    return JSON.stringify({ ok: true });
  }
  const line = `[outbound] ${toolName} ${JSON.stringify(input).slice(0, 80)}`;
  appendOutbound(line);
  return JSON.stringify({ ok: true });
}

const STUB_TOOLS = [
  { name: 'read_messages',   description: 'stub: read bus messages',   inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'send_message',    description: 'stub: send a bus message',  inputSchema: { type: 'object', properties: { to_id:{type:'string'}, content:{type:'string'}, type:{type:'string'} }, required: ['to_id','content','type'] } },
  { name: 'update_status',   description: 'stub: update agent status', inputSchema: { type: 'object', properties: { state:{type:'string'}, current_task:{type:'string'} }, required: ['state'] } },
  { name: 'report_done',     description: 'stub: report task done',    inputSchema: { type: 'object', properties: { orchestrator_id:{type:'string'}, content:{type:'string'} }, required: ['orchestrator_id','content'] } },
  { name: 'start_task',      description: 'stub: start task',          inputSchema: { type: 'object', properties: { title:{type:'string'} }, required: ['title'] } },
  { name: 'finish_task',     description: 'stub: finish task',         inputSchema: { type: 'object', properties: { task_id:{type:'number'}, status:{type:'string'} }, required: ['task_id','status'] } },
  { name: 'delegate_task',   description: 'stub: delegate task',       inputSchema: { type: 'object', properties: { to_id:{type:'string'}, title:{type:'string'}, content:{type:'string'} }, required: ['to_id','title','content'] } },
  { name: 'list_workers',    description: 'stub: list workers',        inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'get_history',     description: 'stub: get history',         inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'spawn_agent',     description: 'stub: spawn agent',         inputSchema: { type: 'object', properties: { task:{type:'string'} }, required: ['task'] } },
  { name: 'request_approval',description: 'stub: request approval',    inputSchema: { type: 'object', properties: { question:{type:'string'} }, required: ['question'] } },
];

function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}
function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  while (true) {
    const he = buf.indexOf('\r\n\r\n');
    if (he === -1) break;
    const hdr = buf.slice(0, he);
    const lm = hdr.match(/Content-Length:\s*(\d+)/i);
    if (!lm) { buf = buf.slice(he + 4); continue; }
    const len = parseInt(lm[1], 10);
    if (buf.length < he + 4 + len) break;
    const body = buf.slice(he + 4, he + 4 + len);
    buf = buf.slice(he + 4 + len);
    handleMsg(body);
  }
});

function handleMsg(body) {
  let msg;
  try { msg = JSON.parse(body); } catch { return; }
  const { id, method, params } = msg;
  log(`← ${method} (id=${id ?? 'notify'})`);

  if (method === 'ping') { respond(id, {}); return; }
  if (method === 'initialize') {
    respond(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'synapse-bus-stub', version: '1.0.0' } });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') { respond(id, { tools: STUB_TOOLS }); return; }
  if (method === 'tools/call') {
    const name  = String(params?.name ?? '');
    const input = params?.arguments ?? {};
    try {
      respond(id, { content: [{ type: 'text', text: handleTool(name, input) }], isError: false });
    } catch(e) {
      respond(id, { content: [{ type: 'text', text: String(e) }], isError: true });
    }
    return;
  }
  if (id != null) respondError(id, -32601, `Method not found: ${method}`);
}

process.stdin.on('end', () => { log('stdin closed'); process.exit(0); });
log(`started  queue=${QUEUE_FILE}  outbound=${OUTBOUND_FILE}`);
