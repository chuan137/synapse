/**
 * test-supervisor-isolated.ts — supervisor with stub MCP isolation
 *
 * Spawns claude -p with --mcp-config pointing to stub-mcp-server.ts.
 * All synapse-bus tool calls are intercepted by the stub; no real DB writes.
 * Run: npx tsx experiments/test-supervisor-isolated.ts
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

const TURN1 = `Read /Users/D067954/Documents/Claude/Projects/synapse/.synapse/SYNAPSE.md and acknowledge in one sentence — do not summarize.`;
const TURN2 = 'How should I use worktrees when developing in this project?';

function userEvent(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
}

function elapsed(): string {
  return `+${((Date.now() - START) / 1000).toFixed(2)}s`;
}

function trunc(s: string, n = 80): string {
  const flat = String(s ?? '').replace(/\n/g, '↵');
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}

function formatContentBlock(block: any): string {
  const t = block?.type ?? '?';
  if (t === 'text')        return `  text        ${trunc(block.text ?? '')}`;
  if (t === 'thinking')    return `  thinking    ${trunc(block.thinking ?? '')}`;
  if (t === 'tool_use')    return `  tool_use    ${block.name ?? '?'}  input=${trunc(JSON.stringify(block.input ?? {}), 60)}`;
  if (t === 'tool_result') {
    const content = Array.isArray(block.content) ? block.content : [];
    const text = content.find((c: any) => c.type === 'text')?.text ?? JSON.stringify(block.content ?? '');
    return `  tool_result [${String(block.tool_use_id ?? '').slice(-8)}] ${block.is_error ? 'err' : 'ok'}  ${trunc(text)}`;
  }
  return `  ${t}  ${trunc(JSON.stringify(block), 80)}`;
}

function summarise(line: string): string[] {
  try {
    const ev = JSON.parse(line) as Record<string, unknown>;
    const type = String(ev.type ?? '?');
    const subtype = ev.subtype ? `/${ev.subtype}` : '';
    const header = `${type}${subtype}`;

    if (type === 'assistant') {
      const blocks: any[] = Array.isArray((ev.message as any)?.content) ? (ev.message as any).content : [];
      return [header, ...blocks.map(formatContentBlock)];
    }
    if (type === 'user') {
      const blocks: any[] = Array.isArray((ev.message as any)?.content) ? (ev.message as any).content : [];
      if (!blocks.length) return [header];
      return [header, ...blocks.map(formatContentBlock)];
    }
    if (type === 'result') {
      const res = ev as any;
      const usage = res.usage ?? {};
      const cost = res.total_cost_usd ?? res.cost_usd ?? 0;
      return [
        `${header}  turns=${res.num_turns ?? '?'}  cost=$${Number(cost).toFixed(4)}`,
        `  tokens: in=${usage.input_tokens ?? 0} out=${usage.output_tokens ?? 0} cache_create=${usage.cache_creation_input_tokens ?? 0} cache_read=${usage.cache_read_input_tokens ?? 0}`,
      ];
    }
    if (type === 'system') {
      const s = ev as any;
      if (subtype === '/init') {
        const servers = (s.mcp_servers ?? []).map((m: any) => `${m.name}(${m.status})`).join(', ');
        return [
          `${header}  session=${String(s.session_id ?? '').slice(-8)}  model=${s.model ?? '?'}`,
          `  mcp_servers: ${servers || '(none)'}`,
          `  tools loaded: ${(s.tools ?? []).length}`,
        ];
      }
      return [`${header}  ${trunc(String(s.hook_name ?? s.session_id ?? ''), 60)}`];
    }
    return [header + '  ' + trunc(JSON.stringify(ev), 80)];
  } catch {
    return ['(non-json) ' + line.slice(0, 100)];
  }
}

async function main() {
  // Write mcp config pointing to our stub server
  const mcpConfigPath = path.join(os.tmpdir(), `stub-mcp-${Date.now()}.json`);
  const stubServerPath = path.join(PROJECT_ROOT, 'experiments', 'stub-mcp-server.ts');
  const mcpConfig = {
    mcpServers: {
      'synapse-bus': {
        type: 'stdio',
        command: 'npx',
        args: ['tsx', stubServerPath],
        env: {},
      },
    },
  };
  fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
  console.log(`[sup]   ${elapsed()}  mcp-config: ${mcpConfigPath}`);
  console.log(`[sup]   ${elapsed()}  stub server: ${stubServerPath}`);

  // Record message count in real DB before experiment
  const dbPath = path.join('/Users/D067954/Documents/Claude/Projects/synapse', '.synapse', 'synapse.db');
  let msgCountBefore = -1;
  try {
    const result = execSync(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM messages WHERE created_at > ${Date.now() - 5000}"`, { encoding: 'utf8' });
    msgCountBefore = parseInt(result.trim(), 10);
  } catch { /* sqlite3 might not be installed */ }

  const child = spawn(
    'claude',
    [
      '-p',
      '--input-format=stream-json', '--output-format=stream-json', '--verbose',
      '--dangerously-skip-permissions', '--max-turns', '10',
      '--mcp-config', mcpConfigPath,
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      cwd: PROJECT_ROOT,  // set cwd to project root so .synapse/ paths work
    }
  );

  const eventCounts: Record<string, number> = {};
  let firstTimestamp = '';
  let lastTimestamp = '';
  let resultCount = 0;
  let successCount = 0;
  let mcpServers: string[] = [];

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    // stub-mcp lines go to stderr of child's stderr; forward with prefix
    text.split('\n').filter(Boolean).forEach(l => {
      if (l.includes('[stub-mcp]')) {
        console.log(`[stub  ] ${elapsed()}  ${l.replace('[stub-mcp] ', '').trim()}`);
      } else {
        process.stderr.write(`[stderr] ${l}\n`);
      }
    });
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  const waitForResult = (): Promise<void> =>
    new Promise(resolve => {
      const handler = (line: string) => {
        try {
          const ev = JSON.parse(line) as Record<string, unknown>;
          if (ev.type === 'result') { rl.off('line', handler); resolve(); }
        } catch {}
      };
      rl.on('line', handler);
    });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    try {
      const ev = JSON.parse(line) as Record<string, unknown>;
      const type = String(ev.type ?? 'unknown');
      const subtype = ev.subtype ? `/${ev.subtype}` : '';
      const key = `${type}${subtype}`;
      eventCounts[key] = (eventCounts[key] ?? 0) + 1;

      const ts = elapsed();
      if (!firstTimestamp) firstTimestamp = ts;
      lastTimestamp = ts;

      if (type === 'result') { resultCount++; if (ev.subtype === 'success') successCount++; }
      if (type === 'system' && subtype === '/init') {
        mcpServers = ((ev as any).mcp_servers ?? []).map((m: any) => `${m.name}(${m.status})`);
      }

      const lines = summarise(line);
      console.log(`[child→] ${ts}  ${lines[0]}`);
      for (let i = 1; i < lines.length; i++) console.log(`           ${lines[i]}`);
    } catch {
      console.log(`[child→] ${elapsed()}  (non-json) ${line.slice(0, 120)}`);
    }
  });

  console.log(`\n[sup]   ${elapsed()}  → turn 1\n`);
  child.stdin.write(userEvent(TURN1));
  await waitForResult();

  console.log(`\n[sup]   ${elapsed()}  turn 1 complete — sending turn 2\n`);
  child.stdin.write(userEvent(TURN2));
  await waitForResult();

  console.log(`\n[sup]   ${elapsed()}  turn 2 complete — closing stdin\n`);
  child.stdin.end();

  const exitCode = await new Promise<number | null>(resolve => child.on('close', resolve));

  // Check DB pollution
  let msgCountAfter = -1;
  let pollutionCheck = 'sqlite3 not available';
  try {
    const result = execSync(`sqlite3 "${dbPath}" "SELECT COUNT(*) FROM messages WHERE created_at > ${Date.now() - 120000}"`, { encoding: 'utf8' });
    msgCountAfter = parseInt(result.trim(), 10);
    const delta = msgCountAfter - Math.max(0, msgCountBefore);
    pollutionCheck = delta > 0
      ? `⚠ POSSIBLE POLLUTION: ${delta} new messages in DB during experiment`
      : `✓ NO POLLUTION: message count unchanged (${msgCountAfter} recent msgs, expected ~${msgCountBefore})`;
  } catch (e) { pollutionCheck = `check failed: ${e}`; }

  // Cleanup temp file
  try { fs.unlinkSync(mcpConfigPath); } catch {}

  const totalMs = Date.now() - START;
  console.log('\n════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('════════════════════════════════════════════════════════');
  console.log(`  Total runtime     : ${(totalMs / 1000).toFixed(2)}s`);
  console.log(`  Child exit code   : ${exitCode ?? 'null'}`);
  console.log(`  Result events     : ${resultCount} (${successCount} success)`);
  console.log(`  MCP servers       : ${mcpServers.join(', ') || '(none)'}`);
  console.log(`  DB isolation      : ${pollutionCheck}`);
  console.log('  Event counts:');
  for (const [k, v] of Object.entries(eventCounts).sort()) {
    console.log(`    ${k.padEnd(28)} ${v}`);
  }
  console.log('════════════════════════════════════════════════════════');

  process.exit(0);
}

main().catch(e => { console.error('[sup] fatal:', e); process.exit(1); });
