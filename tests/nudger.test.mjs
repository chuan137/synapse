#!/usr/bin/env node
/**
 * Tests for Nudger class.
 * Run: node tests/nudger.test.mjs
 *
 * Uses constructor-injected mocks — no tmux or DB calls.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { Nudger } = await import(join(ROOT, 'dist', 'nudge.js'));

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

// ── Test 1: pingAgent returns false when getTmuxPane returns null ──────────────

console.log('\n[Test 1] pingAgent returns false when getTmuxPane returns null');

{
  let execCalled = false;
  const nudger = new Nudger({
    getTmuxPane: (_id) => null,
    execFileSync: (_cmd, _args) => { execCalled = true; return Buffer.alloc(0); },
    getIdleAgentsWithUnreadSignature: () => [],
  });
  const result = nudger.pingAgent('some-agent:1');
  assert(result === false, `pingAgent returns false when no pane`);
  assert(!execCalled, `execFileSync not called when no pane`);
}

// ── Test 2: de-dupe — second _poll for same max_msg_id does not fire again ────

console.log('\n[Test 2] de-dupe: same max_msg_id does not fire send-keys twice');

{
  let execCallCount = 0;
  const rows = [{ agent_id: 'proj:1', tmux_pane: '%42', max_msg_id: 100 }];
  const nudger = new Nudger({
    getTmuxPane: (_id) => '%42',
    execFileSync: (_cmd, _args) => { execCallCount++; return Buffer.alloc(0); },
    getIdleAgentsWithUnreadSignature: () => rows,
  });

  nudger['_poll']();
  nudger['_poll']();

  assert(execCallCount === 1, `send-keys fired exactly once for same max_msg_id`);
}

// ── Test 3: cleanup pass removes agents that leave the unread query ────────────

console.log('\n[Test 3] cleanup pass: agents gone from unread query are removed from de-dupe map');

{
  let execCallCount = 0;
  let returnRows = [{ agent_id: 'proj:2', tmux_pane: '%43', max_msg_id: 10 }];
  const nudger = new Nudger({
    getTmuxPane: (_id) => '%43',
    execFileSync: (_cmd, _args) => { execCallCount++; return Buffer.alloc(0); },
    getIdleAgentsWithUnreadSignature: () => returnRows,
  });

  // First poll: agent has unread, gets nudged
  nudger['_poll']();
  assert(execCallCount === 1, `first poll fires send-keys`);

  // Simulate agent read messages — drops out of the unread query
  returnRows = [];
  nudger['_poll']();

  // Agent re-appears with a new message
  returnRows = [{ agent_id: 'proj:2', tmux_pane: '%43', max_msg_id: 11 }];
  nudger['_poll']();
  assert(execCallCount === 2, `after cleanup, new message triggers send-keys again`);
}

// ── Test 4: start()/stop() lifecycle ──────────────────────────────────────────

console.log('\n[Test 4] start/stop lifecycle: stop() clears the interval');

{
  let pollCount = 0;
  const nudger = new Nudger({
    getTmuxPane: (_id) => null,
    execFileSync: (_cmd, _args) => Buffer.alloc(0),
    getIdleAgentsWithUnreadSignature: () => {
      pollCount++;
      return [];
    },
  });

  nudger.start(10);
  await new Promise(r => setTimeout(r, 55)); // ~5 ticks at 10ms
  nudger.stop();
  const countAfterStop = pollCount;
  await new Promise(r => setTimeout(r, 40)); // wait more — should see no new ticks
  assert(pollCount >= 3, `interval fired at least 3 times before stop (got ${pollCount})`);
  assert(pollCount === countAfterStop, `no new ticks after stop() (${pollCount} === ${countAfterStop})`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n=== TEST SUMMARY ===`);
console.log(`PASS: ${passed}  FAIL: ${failed}`);
if (failed > 0) process.exit(1);
