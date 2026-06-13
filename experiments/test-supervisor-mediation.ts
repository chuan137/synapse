/**
 * test-supervisor-mediation.ts — supervisor as bus surface with isolated real MCP.
 *
 * Uses SYNAPSE_DB_PATH=<temp> so all MCP calls hit an isolated DB.
 * Supervisor seeds inbound messages AFTER synapse mcp initializes the schema,
 * then reads outbound messages from the isolated DB after each turn.
 * Also demonstrates mid-turn stdin inject.
 *
 * Run: npx tsx experiments/test-supervisor-mediation.ts
 */

import { spawn, execSync } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

const START = Date.now();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const ISO_DB_PATH  = path.join(os.tmpdir(), `sup-mediation-${Date.now()}.db`);
const OUTBOUND_LOG = path.join(PROJECT_ROOT, 'experiments', 'test-supervisor-mediation-outbound.log');

function elapsed(): string {
  return `+${((Date.now() - START) / 1000).toFixed(2)}s`;
}

function userEvent(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
}

function trunc(s: string, n = 80): string {
  const flat = String(s ?? '').replace(/\n/g, '↵');
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

function formatBlock(block: any): string {
  const t = block?.type ?? '?';
  if (t === 'text')        return `  text        ${trunc(block.text ?? '')}`;
  if (t === 'tool_use')    return `  tool_use    ${block.name ?? '?'}  input=${trunc(JSON.stringify(block.input ?? {}), 60)}`;
  if (t === 'tool_result') {
    const content = Array.isArray(block.content) ? block.content : [];
    const text = content.find((c: any) => c.type === 'text')?.text ?? '';
    return `  tool_result [${String(block.tool_use_id ?? '').slice(-8)}] ${block.is_error ? 'err' : 'ok'}  ${trunc(text)}`;
  }
  return `  ${t}  ${trunc(JSON.stringify(block), 70)}`;
}

function summarise(line: string): string[] {
  try {
    const ev = JSON.parse(line) as Record<string, unknown>;
    const type = String(ev.type ?? '?');
    const sub  = ev.subtype ? `/${ev.subtype}` : '';
    if (type === 'assistant') {
      const blocks: any[] = Array.isArray((ev.message as any)?.content) ? (ev.message as any).content : [];
      return [`assistant`, ...blocks.map(formatBlock)];
    }
    if (type === 'user') {
      const blocks: any[] = Array.isArray((ev.message as any)?.content) ? (ev.message as any).content : [];
      if (!blocks.length) return ['user (no blocks)'];
      return ['user', ...blocks.map(formatBlock)];
    }
    if (type === 'result') {
      const r = ev as any;
      const u = r.usage ?? {};
      return [
        `result${sub}  turns=${r.num_turns ?? '?'}  cost=$${Number(r.total_cost_usd ?? 0).toFixed(4)}`,
        `  tokens: in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0}`,
      ];
    }
    if (type === 'system' && sub === '/init') {
      const s = ev as any;
      const servers = (s.mcp_servers ?? []).map((m: any) => `${m.name}(${m.status})`).join(', ');
      return [`system/init  session=${String(s.session_id ?? '').slice(-8)}  mcp=${servers}  tools=${(s.tools ?? []).length}`];
    }
    return [`${type}${sub}  ${trunc(JSON.stringify(ev), 70)}`];
  } catch {
    return ['(non-json) ' + line.slice(0, 80)];
  }
}

/** Insert a message into the isolated DB so read_messages will find it */
function seedMessage(dbPath: string, fromId: string, toId: string, content: string) {
  execSync(
    `sqlite3 "${dbPath}" "INSERT INTO messages (from_id, to_id, content, priority, type, created_at) VALUES ('${fromId}','${toId}','${content.replace(/'/g, "''")}',0,'message',${Date.now()})"`,
    { encoding: 'utf8' }
  );
}

/** Read outbound messages from isolated DB (written by synapse mcp) */
function readOutbound(dbPath: string, since: number): Array<{from_id: string, to_id: string, content: string}> {
  try {
    const raw = execSync(
      `sqlite3 "${dbPath}" "SELECT from_id,to_id,substr(content,1,120) FROM messages WHERE created_at > ${since} AND from_id != 'cec50b17:0' AND from_id != 'system'"`,
      { encoding: 'utf8' }
    ).trim();
    if (!raw) return [];
    return raw.split('\n').map(l => {
      const i1 = l.indexOf('|'), i2 = l.indexOf('|', i1 + 1);
      return { from_id: l.slice(0, i1), to_id: l.slice(i1 + 1, i2), content: l.slice(i2 + 1) };
    });
  } catch { return []; }
}

/** Read agent status from isolated DB (if agents table exists) */
function readAgentStatus(dbPath: string): Array<{agent_id: string, state: string, current_task: string}> {
  try {
    const tables = execSync(`sqlite3 "${dbPath}" ".tables"`, { encoding: 'utf8' });
    if (!tables.includes('agents')) return [];
    const raw = execSync(`sqlite3 "${dbPath}" "SELECT agent_id,state,current_task FROM agents"`, { encoding: 'utf8' }).trim();
    if (!raw) return [];
    return raw.split('\n').map(l => { const p = l.split('|'); return { agent_id: p[0], state: p[1], current_task: p[2] }; });
  } catch { return []; }
}

async function main() {
  fs.writeFileSync(OUTBOUND_LOG, '', 'utf8');
  console.log(`[sup]   ${elapsed()}  isolated DB: ${ISO_DB_PATH}`);
  console.log(`[sup]   ${elapsed()}  outbound log: ${OUTBOUND_LOG}`);

  const child = spawn(
    'claude',
    ['-p', '--input-format=stream-json', '--output-format=stream-json', '--verbose',
     '--dangerously-skip-permissions', '--max-turns', '10'],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SYNAPSE_DB_PATH: ISO_DB_PATH }, cwd: PROJECT_ROOT }
  );

  const eventCounts: Record<string, number> = {};
  let mcpServers: string[] = [];
  let mcpReady = false;
  const turnStart = Date.now();

  child.stderr.on('data', (chunk: Buffer) => {
    chunk.toString().split('\n').filter(Boolean).forEach(l => process.stderr.write(`[stderr] ${l}\n`));
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  const waitFor = (pred: (ev: any) => boolean): Promise<any> =>
    new Promise(resolve => {
      const handler = (line: string) => {
        try {
          const ev = JSON.parse(line);
          if (pred(ev)) { rl.off('line', handler); resolve(ev); }
        } catch {}
      };
      rl.on('line', handler);
    });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    try {
      const ev = JSON.parse(line) as any;
      const key = `${ev.type}${ev.subtype ? '/' + ev.subtype : ''}`;
      eventCounts[key] = (eventCounts[key] ?? 0) + 1;
      if (ev.type === 'system' && ev.subtype === 'init') {
        mcpServers = (ev.mcp_servers ?? []).map((m: any) => `${m.name}(${m.status})`);
        // Wait briefly after init for MCP to finish connecting, then seed DB
        if (!mcpReady) {
          mcpReady = true;
          // Wait for synapse mcp to write agent.env and claim a slot
          setTimeout(() => {
            try {
              // Read the agent_id claimed by synapse mcp from agent.env
              let toId = 'human'; // fallback
              try {
                const agentEnv = fs.readFileSync(path.join(PROJECT_ROOT, '.synapse', 'agent.env'), 'utf8');
                const match = agentEnv.match(/SYNAPSE_AGENT_ID=(\S+)/);
                if (match) toId = match[1];
              } catch {}
              const operatorMsg = "Hello from operator — please reply with the string 'mediation OK' via send_message to 'human'.";
              seedMessage(ISO_DB_PATH, 'cec50b17:0', toId, operatorMsg);
              console.log(`\n[sup]   ${elapsed()}  ⬇ seeded DB: to=${toId} msg: ${operatorMsg.slice(0, 50)}`);
            } catch (e) {
              console.log(`[sup]   ${elapsed()}  seed failed: ${e}`);
            }
          }, 800);
        }
      }
    } catch {}
    const lines = summarise(line);
    console.log(`[child→] ${elapsed()}  ${lines[0]}`);
    for (let i = 1; i < lines.length; i++) console.log(`           ${lines[i]}`);
  });

  // Turn 1: task that uses read_messages
  const TURN1_PROMPT = `You are a developer worker. Call read_messages once. If there is a message from an agent, carry out the instruction in it (use send_message to 'human' with content 'mediation OK' and type 'message'). Then call update_status with state='idle' and current_task='task done'. Stop after that.`;

  console.log(`\n[sup]   ${elapsed()}  → turn 1 (inbound via DB queue)\n`);
  child.stdin.write(userEvent(TURN1_PROMPT));

  const resultP1 = waitFor(ev => ev.type === 'result');

  // Mid-turn direct stdin inject at t=4s (wait for MCP to be ready)
  const injectTimer = setTimeout(() => {
    const inject = `Also call update_status with state='working' and current_task='running mediation test'. Then finish.`;
    console.log(`\n[sup]   ${elapsed()}  ⬆ direct stdin inject: ${inject.slice(0, 60)}\n`);
    child.stdin.write(userEvent(inject));
  }, 4000);

  const r1 = await resultP1;
  clearTimeout(injectTimer);
  console.log(`\n[sup]   ${elapsed()}  turn 1 complete (${r1.subtype})\n`);

  // Read outbound from isolated DB
  const outbound = readOutbound(ISO_DB_PATH, turnStart);
  const agentStatus = readAgentStatus(ISO_DB_PATH);
  console.log(`[sup]   ${elapsed()}  outbound messages captured: ${outbound.length}`);
  for (const m of outbound) {
    const line = `[outbound] send_message from=${m.from_id} to=${m.to_id} type=${m.type} content=${JSON.stringify(m.content.slice(0, 100))}`;
    console.log(`[sup]   ${elapsed()}  ${line}`);
    fs.appendFileSync(OUTBOUND_LOG, line + '\n', 'utf8');
  }
  for (const a of agentStatus) {
    const line = `[outbound] update_status agent=${a.agent_id} state=${a.state} task=${JSON.stringify(a.current_task ?? '')}`;
    console.log(`[sup]   ${elapsed()}  ${line}`);
    fs.appendFileSync(OUTBOUND_LOG, line + '\n', 'utf8');
  }

  child.stdin.end();
  const exitCode = await new Promise<number | null>(resolve => child.on('close', resolve));

  // DB pollution check
  let pollutionCheck = 'check skipped';
  try {
    const realDb = '/Users/D067954/Documents/Claude/Projects/synapse/.synapse/synapse.db';
    const since = Date.now() - 180_000;
    const count = parseInt(execSync(`sqlite3 "${realDb}" "SELECT COUNT(*) FROM messages WHERE created_at > ${since}"`, { encoding: 'utf8' }).trim(), 10);
    pollutionCheck = count === 0
      ? `✓ NO POLLUTION (0 new messages in real DB)`
      : `⚠ POLLUTION: ${count} new messages in real DB`;
  } catch (e) { pollutionCheck = `check failed: ${e}`; }

  // Outbound log
  let outboundLines: string[] = [];
  try { outboundLines = fs.readFileSync(OUTBOUND_LOG, 'utf8').split('\n').filter(Boolean); } catch {}

  // Verify key assertions
  const hasMediationOK = outboundLines.some(l => l.includes('mediation OK'));
  const hasWorkingStatus = outboundLines.some(l => l.includes('working'));
  const hasIdleStatus = outboundLines.some(l => l.includes('idle'));

  // Cleanup
  try { fs.unlinkSync(ISO_DB_PATH); } catch {}

  const totalMs = Date.now() - START;
  console.log('\n════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('════════════════════════════════════════════════════════');
  console.log(`  Total runtime     : ${(totalMs / 1000).toFixed(2)}s`);
  console.log(`  Child exit code   : ${exitCode ?? 'null'}`);
  console.log(`  MCP servers       : ${mcpServers.join(', ') || '(none)'}`);
  console.log(`  DB isolation      : ${pollutionCheck}`);
  console.log(`  send_message 'mediation OK' captured: ${hasMediationOK ? '✓ YES' : '✗ NO'}`);
  console.log(`  update_status 'working' captured    : ${hasWorkingStatus ? '✓ YES' : '✗ NO'}`);
  console.log(`  update_status 'idle' captured       : ${hasIdleStatus ? '✓ YES' : '✗ NO'}`);
  console.log('  Event counts:');
  for (const [k, v] of Object.entries(eventCounts).sort()) {
    console.log(`    ${k.padEnd(28)} ${v}`);
  }
  console.log('\n  Outbound log:');
  for (const l of outboundLines) console.log(`    ${l}`);
  console.log('════════════════════════════════════════════════════════');

  process.exit(0);
}

main().catch(e => { console.error('[sup] fatal:', e); process.exit(1); });
