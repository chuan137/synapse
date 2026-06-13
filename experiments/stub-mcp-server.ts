/**
 * stub-mcp-server.ts — stateful stdio MCP server intercepting synapse-bus tool calls.
 *
 * Reads inbound queue from STUB_QUEUE_FILE (env var).
 * Writes outbound events to STUB_OUTBOUND_FILE (env var).
 * Exposes all synapse-bus tool names with live behavior:
 *   - read_messages: drains STUB_QUEUE_FILE, returns messages
 *   - update_status: logs + appends to outbound
 *   - send_message:  logs + appends to outbound
 *   - report_done:   logs + appends to outbound
 *   - others:        canned OK
 *
 * Run via mcp-config by supervisor.
 */

import * as fs from 'fs';

const QUEUE_FILE    = process.env.STUB_QUEUE_FILE    ?? '/tmp/stub-queue.json';
const OUTBOUND_FILE = process.env.STUB_OUTBOUND_FILE ?? '/tmp/stub-outbound.log';

function log(msg: string) {
  process.stderr.write(`[stub-mcp] ${msg}\n`);
}

function appendOutbound(line: string) {
  try { fs.appendFileSync(OUTBOUND_FILE, line + '\n', 'utf8'); } catch {}
}

function readQueue(): unknown[] {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    const raw = fs.readFileSync(QUEUE_FILE, 'utf8').trim();
    if (!raw) return [];
    const msgs = JSON.parse(raw);
    // Drain: clear the file after reading
    fs.writeFileSync(QUEUE_FILE, '[]', 'utf8');
    return Array.isArray(msgs) ? msgs : [];
  } catch { return []; }
}

function handleTool(toolName: string, input: Record<string, unknown>): string {
  log(`  tool: ${toolName}  input=${JSON.stringify(input).slice(0, 100)}`);

  if (toolName === 'read_messages') {
    const msgs = readQueue();
    const result = msgs.length > 0
      ? msgs
      : [{ id: 0, from: 'system', content: 'No new messages.\n\n[Synapse] Now call update_status to report your current state.', priority: 5, at: new Date().toISOString() }];
    appendOutbound(`[inbound_read] drained ${msgs.length} messages`);
    return JSON.stringify(result, null, 2);
  }

  if (toolName === 'update_status') {
    const state = input.state ?? '?';
    const task  = input.current_task ?? '';
    const line  = `[outbound] update_status state=${state}${task ? ' task=' + JSON.stringify(task) : ''}`;
    log(line);
    appendOutbound(line);
    return `Status updated: ${state}${task ? ' — ' + task : ''}.`;
  }

  if (toolName === 'send_message') {
    const to      = input.to_id ?? 'unknown';
    const content = String(input.content ?? '');
    const type    = input.type ?? 'message';
    const line    = `[outbound] send_message to=${to} type=${type} content=${JSON.stringify(content.slice(0, 120))}`;
    log(line);
    appendOutbound(line);
    return JSON.stringify({ ok: true, message_id: Math.floor(Math.random() * 9000) + 1000 });
  }

  if (toolName === 'report_done') {
    const orch    = input.orchestrator_id ?? '?';
    const content = String(input.content ?? '').slice(0, 120);
    const line    = `[outbound] report_done orchestrator=${orch} content=${JSON.stringify(content)}`;
    log(line);
    appendOutbound(line);
    return JSON.stringify({ ok: true });
  }

  if (toolName === 'start_task') {
    const line = `[outbound] start_task title=${JSON.stringify(input.title ?? '')}`;
    log(line); appendOutbound(line);
    return JSON.stringify({ task_id: 9999, title: input.title ?? 'stub' });
  }

  if (toolName === 'finish_task') {
    const line = `[outbound] finish_task id=${input.task_id} status=${input.status}`;
    log(line); appendOutbound(line);
    return JSON.stringify({ ok: true });
  }

  // Catch-all
  const line = `[outbound] ${toolName} ${JSON.stringify(input).slice(0, 80)}`;
  appendOutbound(line);
  return JSON.stringify({ ok: true });
}

const STUB_TOOLS = [
  { name: 'read_messages',    description: 'stub: read bus messages',   inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'send_message',     description: 'stub: send a bus message',  inputSchema: { type: 'object', properties: { to_id: {type:'string'}, content: {type:'string'}, type: {type:'string'} }, required: ['to_id','content','type'] } },
  { name: 'update_status',    description: 'stub: update agent status', inputSchema: { type: 'object', properties: { state: {type:'string'}, current_task: {type:'string'} }, required: ['state'] } },
  { name: 'report_done',      description: 'stub: report task done',    inputSchema: { type: 'object', properties: { orchestrator_id:{type:'string'}, content:{type:'string'} }, required:['orchestrator_id','content'] } },
  { name: 'start_task',       description: 'stub: start a task',        inputSchema: { type: 'object', properties: { title:{type:'string'} }, required:['title'] } },
  { name: 'finish_task',      description: 'stub: finish a task',       inputSchema: { type: 'object', properties: { task_id:{type:'number'}, status:{type:'string'} }, required:['task_id','status'] } },
  { name: 'delegate_task',    description: 'stub: delegate a task',     inputSchema: { type: 'object', properties: { to_id:{type:'string'}, title:{type:'string'}, content:{type:'string'} }, required:['to_id','title','content'] } },
  { name: 'list_workers',     description: 'stub: list workers',        inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'get_history',      description: 'stub: get history',         inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  { name: 'spawn_agent',      description: 'stub: spawn agent',         inputSchema: { type: 'object', properties: { task:{type:'string'} }, required:['task'] } },
  { name: 'request_approval', description: 'stub: request approval',    inputSchema: { type: 'object', properties: { question:{type:'string'} }, required:['question'] } },
];

function respond(id: number | string | null, result: unknown) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}

function respondError(id: number | string | null, code: number, message: string) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buffer += chunk;
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const header = buffer.slice(0, headerEnd);
    const lenMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!lenMatch) { buffer = buffer.slice(headerEnd + 4); continue; }
    const len = parseInt(lenMatch[1], 10);
    if (buffer.length < headerEnd + 4 + len) break;
    const body = buffer.slice(headerEnd + 4, headerEnd + 4 + len);
    buffer = buffer.slice(headerEnd + 4 + len);
    handleMessage(body);
  }
});

function handleMessage(body: string) {
  let msg: any;
  try { msg = JSON.parse(body); } catch { log(`bad JSON: ${body.slice(0, 80)}`); return; }
  const { id, method, params } = msg;
  log(`← ${method} (id=${id ?? 'notify'})`);

  if (method === 'initialize') {
    respond(id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'synapse-bus-stub', version: '1.0.0' } });
    return;
  }
  if (method === 'notifications/initialized') { return; }
  if (method === 'tools/list') {
    respond(id, { tools: STUB_TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const toolName = String(params?.name ?? '');
    const input    = (params?.arguments ?? {}) as Record<string, unknown>;
    try {
      const text = handleTool(toolName, input);
      respond(id, { content: [{ type: 'text', text }], isError: false });
    } catch (e) {
      respond(id, { content: [{ type: 'text', text: String(e) }], isError: true });
    }
    return;
  }
  if (id !== undefined && id !== null) {
    respondError(id, -32601, `Method not found: ${method}`);
  }
}

process.stdin.on('end', () => { log('stdin closed'); process.exit(0); });
log(`started  queue=${QUEUE_FILE}  outbound=${OUTBOUND_FILE}`);
