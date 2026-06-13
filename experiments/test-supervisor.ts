/**
 * test-supervisor.ts — prototype supervisor for claude -p --input-format=stream-json
 *
 * Spawns a claude process, sends two turns, streams all events with rich tool-call
 * pretty-printing, prints a summary.
 * Run: npx tsx experiments/test-supervisor.ts
 *
 * No production error handling — this is a probe.
 */

import { spawn } from 'child_process';
import * as readline from 'readline';

const START = Date.now();

const TURN1 = 'Read .synapse/SYNAPSE.md and .synapse/SYNAPSE-worker.md. Acknowledge when done in one sentence — do not summarize.';
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
  if (t === 'text')       return `  text        ${trunc(block.text ?? '')}`;
  if (t === 'thinking')   return `  thinking    ${trunc(block.thinking ?? '')}`;
  if (t === 'tool_use')   return `  tool_use    ${block.name ?? '?'}  input=${trunc(JSON.stringify(block.input ?? {}), 60)}`;
  if (t === 'tool_result') {
    const content = Array.isArray(block.content) ? block.content : [];
    const text = content.find((c: any) => c.type === 'text')?.text ?? JSON.stringify(block.content ?? '');
    const status = block.is_error ? 'err' : 'ok';
    return `  tool_result [${String(block.tool_use_id ?? '').slice(-8)}] ${status}  ${trunc(text)}`;
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
      const msg = ev.message as any;
      const blocks: any[] = Array.isArray(msg?.content) ? msg.content : [];
      const lines = [header];
      for (const b of blocks) lines.push(formatContentBlock(b));
      return lines;
    }

    if (type === 'user') {
      const msg = ev.message as any;
      // Echo of user events includes tool_result blocks
      const blocks: any[] = Array.isArray(msg?.content) ? msg.content : [];
      if (!blocks.length) return [header];
      const lines = [header];
      for (const b of blocks) lines.push(formatContentBlock(b));
      return lines;
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
        const toolCount = (s.tools ?? []).length;
        return [
          `${header}  session=${String(s.session_id ?? '').slice(-8)}  model=${s.model ?? '?'}`,
          `  mcp_servers: ${servers || '(none)'}`,
          `  tools loaded: ${toolCount}`,
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
  const child = spawn(
    'claude',
    ['-p', '--input-format=stream-json', '--output-format=stream-json', '--verbose',
     '--dangerously-skip-permissions', '--max-turns', '10'],
    { stdio: ['pipe', 'pipe', 'pipe'], env: process.env }
  );

  const eventCounts: Record<string, number> = {};
  let firstTimestamp = '';
  let lastTimestamp = '';
  let resultCount = 0;
  let successCount = 0;
  let mcpServers: string[] = [];

  // Stream stderr
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(`[stderr] ${chunk.toString()}`);
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

      if (type === 'result') {
        resultCount++;
        if (ev.subtype === 'success') successCount++;
      }
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

  console.log(`[sup]   ${elapsed()}  → turn 1`);
  child.stdin.write(userEvent(TURN1));

  await waitForResult();
  console.log(`\n[sup]   ${elapsed()}  turn 1 complete — sending turn 2\n`);
  child.stdin.write(userEvent(TURN2));

  await waitForResult();
  console.log(`\n[sup]   ${elapsed()}  turn 2 complete — closing stdin\n`);
  child.stdin.end();

  const exitCode = await new Promise<number | null>(resolve =>
    child.on('close', resolve)
  );

  const totalMs = Date.now() - START;

  console.log('\n════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('════════════════════════════════════════════════════════');
  console.log(`  Total runtime     : ${(totalMs / 1000).toFixed(2)}s`);
  console.log(`  Child exit code   : ${exitCode ?? 'null'}`);
  console.log(`  Turns sent        : 2`);
  console.log(`  Result events     : ${resultCount} (${successCount} success)`);
  console.log(`  First event at    : ${firstTimestamp}`);
  console.log(`  Last event at     : ${lastTimestamp}`);
  console.log(`  MCP servers       : ${mcpServers.join(', ') || '(none)'}`);
  console.log('  Event counts:');
  for (const [k, v] of Object.entries(eventCounts).sort()) {
    console.log(`    ${k.padEnd(28)} ${v}`);
  }
  console.log('════════════════════════════════════════════════════════');

  process.exit(0);
}

main().catch(e => { console.error('[sup] fatal:', e); process.exit(1); });
