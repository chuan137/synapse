/**
 * test-supervisor.ts — prototype supervisor for claude -p --input-format=stream-json
 *
 * Spawns a claude process, sends two turns, streams all events, prints a summary.
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

function summarise(line: string): string {
  try {
    const ev = JSON.parse(line) as Record<string, unknown>;
    const type = String(ev.type ?? '?');
    const subtype = ev.subtype ? `/${ev.subtype}` : '';
    let detail = '';
    if (type === 'assistant') {
      const msg = ev.message as any;
      const parts = Array.isArray(msg?.content) ? msg.content : [];
      const textPart = parts.find((p: any) => p.type === 'text');
      detail = textPart ? String(textPart.text ?? '').slice(0, 80).replace(/\n/g, '↵') : '';
    } else if (type === 'result') {
      const res = ev as any;
      detail = `turns=${res.num_turns ?? '?'} cost=$${(res.cost_usd ?? 0).toFixed(4)}`;
    } else if (type === 'system') {
      detail = String((ev as any).session_id ?? (ev as any).hook_type ?? '').slice(0, 40);
    }
    return `${type}${subtype}${detail ? '  ' + detail : ''}`;
  } catch {
    return line.slice(0, 100);
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
  let turnsDone = 0;

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

  // Collect all lines, emit to console, track counts
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

      console.log(`[child→] ${ts}  ${summarise(line)}`);
    } catch {
      console.log(`[child→] ${elapsed()}  (non-json) ${line.slice(0, 120)}`);
    }
  });

  // Kick off: send turn 1
  console.log(`[sup]   ${elapsed()}  → turn 1`);
  child.stdin.write(userEvent(TURN1));

  // Wait for result before sending turn 2
  await waitForResult();
  turnsDone++;
  console.log(`\n[sup]   ${elapsed()}  turn 1 complete — sending turn 2\n`);
  child.stdin.write(userEvent(TURN2));

  // Wait for second result
  await waitForResult();
  turnsDone++;
  console.log(`\n[sup]   ${elapsed()}  turn 2 complete — closing stdin\n`);
  child.stdin.end();

  // Wait for child exit
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
  console.log('  Event counts:');
  for (const [k, v] of Object.entries(eventCounts).sort()) {
    console.log(`    ${k.padEnd(28)} ${v}`);
  }
  console.log('════════════════════════════════════════════════════════');

  process.exit(0);
}

main().catch(e => { console.error('[sup] fatal:', e); process.exit(1); });
