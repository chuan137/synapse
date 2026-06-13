/**
 * stub-mcp-server.ts — minimal stdio MCP server that intercepts synapse-bus tool calls.
 *
 * Exposes the same tool names as the real synapse-bus MCP server but:
 * - Logs every call to stderr (visible to supervisor as [stub])
 * - Returns canned OK responses (no real DB writes)
 *
 * Run via: npx tsx experiments/stub-mcp-server.ts
 * Wire via mcp-config: {"mcpServers":{"synapse-bus":{"type":"stdio","command":"npx","args":["tsx","experiments/stub-mcp-server.ts"]}}}
 */

import * as readline from 'readline';

const STUB_TOOLS = [
  { name: 'read_messages',     description: 'stub: read bus messages',     inputSchema: { type: 'object', properties: {} } },
  { name: 'send_message',      description: 'stub: send a bus message',    inputSchema: { type: 'object', properties: { to_id: { type: 'string' }, content: { type: 'string' }, type: { type: 'string' } }, required: ['to_id', 'content', 'type'] } },
  { name: 'update_status',     description: 'stub: update agent status',   inputSchema: { type: 'object', properties: { state: { type: 'string' }, current_task: { type: 'string' } }, required: ['state'] } },
  { name: 'report_done',       description: 'stub: report task done',      inputSchema: { type: 'object', properties: { orchestrator_id: { type: 'string' }, content: { type: 'string' } }, required: ['orchestrator_id', 'content'] } },
  { name: 'start_task',        description: 'stub: start a task record',   inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
  { name: 'finish_task',       description: 'stub: finish a task record',  inputSchema: { type: 'object', properties: { task_id: { type: 'number' }, status: { type: 'string' } }, required: ['task_id', 'status'] } },
  { name: 'delegate_task',     description: 'stub: delegate a task',       inputSchema: { type: 'object', properties: { to_id: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['to_id', 'title', 'content'] } },
  { name: 'list_workers',      description: 'stub: list worker agents',    inputSchema: { type: 'object', properties: {} } },
  { name: 'get_history',       description: 'stub: get message history',   inputSchema: { type: 'object', properties: {} } },
  { name: 'spawn_agent',       description: 'stub: spawn a worker',        inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } },
  { name: 'request_approval',  description: 'stub: request approval',      inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] } },
];

const CANNED: Record<string, unknown> = {
  read_messages:    [{ id: 0, from: 'system', content: 'No new messages.\n\n[Synapse] Now call update_status to report your current state.', priority: 5, at: new Date().toISOString() }],
  send_message:     { ok: true },
  update_status:    'Status updated.',
  report_done:      { ok: true },
  start_task:       { task_id: 9999, title: 'stub task' },
  finish_task:      { ok: true },
  delegate_task:    { message_id: 0 },
  list_workers:     [],
  get_history:      [],
  spawn_agent:      { agent_id: 'stub:99' },
  request_approval: { approved: true },
};

function log(msg: string) {
  process.stderr.write(`[stub-mcp] ${msg}\n`);
}

function respond(id: number | string | null, result: unknown) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}

function respondError(id: number | string | null, code: number, message: string) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}

// MCP uses Content-Length framed JSON-RPC over stdio
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
  log(`← ${method} (id=${id})`);

  if (method === 'initialize') {
    respond(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'synapse-bus-stub', version: '0.0.1' },
    });
    return;
  }

  if (method === 'notifications/initialized') { return; }

  if (method === 'tools/list') {
    respond(id, { tools: STUB_TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name ?? '';
    const input = params?.arguments ?? {};
    log(`  tool: ${toolName}  input=${JSON.stringify(input).slice(0, 120)}`);
    const result = CANNED[toolName] ?? { ok: true };
    const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    respond(id, { content: [{ type: 'text', text }], isError: false });
    return;
  }

  // Unknown method
  respondError(id, -32601, `Method not found: ${method}`);
}

process.stdin.on('end', () => { log('stdin closed, exiting'); process.exit(0); });
log('stub MCP server started');
