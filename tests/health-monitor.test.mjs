#!/usr/bin/env node
/**
 * Tests for HealthMonitor class.
 * Run: node tests/health-monitor.test.mjs
 *
 * Uses constructor-injected mocks — no real SQLite or DB calls.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { HealthMonitor } = await import(join(ROOT, 'dist', 'health-monitor.js'));

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

function makeDeps(overrides = {}) {
  return {
    queryAgents: (_threshold) => [],
    sendMessage: () => 1,
    readSynapseSettings: () => ({}),
    ...overrides,
  };
}

// ── Test 1: below threshold → no message ─────────────────────────────────────

console.log('\n[Test 1] Below threshold — no message sent');

{
  let sent = 0;
  const hm = new HealthMonitor({
    thresholdToolCalls: 300,
    deps: makeDeps({
      // Query returns nothing (agent count 299 < 300, so HAVING filters it out)
      queryAgents: (_t) => [],
      sendMessage: () => { sent++; return 1; },
    }),
  });
  hm['_poll']();
  assert(sent === 0, `no message when no agents cross threshold`);
}

// ── Test 2: at threshold → message sent, agent in warnedAgents ───────────────

console.log('\n[Test 2] At threshold — message sent, agent tracked');

{
  let sentContent = null;
  const hm = new HealthMonitor({
    thresholdToolCalls: 300,
    deps: makeDeps({
      queryAgents: (_t) => [{
        agent_id: 'proj:1', orchestrator_id: 'proj:0',
        role: 'developer', tool_call_count: 300, session_id: 'sess-a',
      }],
      sendMessage: (_from, _to, content) => { sentContent = content; return 1; },
    }),
  });
  hm['_poll']();
  assert(sentContent !== null, `message sent at threshold`);
  assert(sentContent.includes('proj:1'), `content includes agent_id`);
  assert(sentContent.includes('300'), `content includes count`);
  assert(sentContent.includes('threshold: 300'), `content includes threshold`);
  assert(hm['warnedAgents'].has('proj:1'), `agent added to warnedAgents`);
}

// ── Test 3: above threshold → message sent ───────────────────────────────────

console.log('\n[Test 3] Above threshold — message sent');

{
  let sent = 0;
  const hm = new HealthMonitor({
    thresholdToolCalls: 300,
    deps: makeDeps({
      queryAgents: (_t) => [{
        agent_id: 'proj:2', orchestrator_id: 'proj:0',
        role: 'developer', tool_call_count: 450, session_id: 'sess-b',
      }],
      sendMessage: () => { sent++; return 1; },
    }),
  });
  hm['_poll']();
  assert(sent === 1, `message sent above threshold`);
}

// ── Test 4: de-dupe — second tick same session does NOT re-send ───────────────

console.log('\n[Test 4] De-dupe — second _poll for same session does not re-send');

{
  let sent = 0;
  const rows = [{
    agent_id: 'proj:3', orchestrator_id: 'proj:0',
    role: 'developer', tool_call_count: 350, session_id: 'sess-c',
  }];
  const hm = new HealthMonitor({
    thresholdToolCalls: 300,
    deps: makeDeps({
      queryAgents: (_t) => rows,
      sendMessage: () => { sent++; return 1; },
    }),
  });
  hm['_poll']();
  hm['_poll']();
  assert(sent === 1, `second poll with same session does not re-send (got ${sent})`);
}

// ── Test 5: orchestrator_id null → skip silently ─────────────────────────────

console.log('\n[Test 5] Null orchestrator_id — skipped silently');

{
  let sent = 0;
  const hm = new HealthMonitor({
    thresholdToolCalls: 300,
    deps: makeDeps({
      queryAgents: (_t) => [{
        agent_id: 'proj:4', orchestrator_id: null,
        role: 'developer', tool_call_count: 400, session_id: 'sess-d',
      }],
      sendMessage: () => { sent++; return 1; },
    }),
  });
  hm['_poll']();
  assert(sent === 0, `no message when orchestrator_id is null`);
}

// ── Test 6: reset on respawn (session_id changed) → fires again ───────────────

console.log('\n[Test 6] Reset on respawn — new session_id clears warnedAgents, fires again');

{
  let sent = 0;
  let sessionId = 'sess-old';
  const hm = new HealthMonitor({
    thresholdToolCalls: 300,
    deps: makeDeps({
      queryAgents: (_t) => [{
        agent_id: 'proj:5', orchestrator_id: 'proj:0',
        role: 'developer', tool_call_count: 320, session_id: sessionId,
      }],
      sendMessage: () => { sent++; return 1; },
    }),
  });

  hm['_poll']();
  assert(sent === 1, `first poll fires`);

  // Simulate restart — new session_id, count resets above threshold again
  sessionId = 'sess-new';
  hm['_poll']();
  assert(sent === 2, `after session change, fires again (got ${sent})`);
}

// ── Test 7: slot 0 excluded (handled by query) ───────────────────────────────

console.log('\n[Test 7] Slot 0 (orchestrator) excluded by SQL query');

{
  let sent = 0;
  // The SQL already has slot > 0 guard — simulate by having queryAgents return nothing
  // (what the DB would return for an orchestrator that crosses threshold)
  const hm = new HealthMonitor({
    thresholdToolCalls: 300,
    deps: makeDeps({
      queryAgents: (_t) => [],  // slot=0 filtered by HAVING slot > 0
      sendMessage: () => { sent++; return 1; },
    }),
  });
  hm['_poll']();
  assert(sent === 0, `orchestrator (slot=0) excluded — no hint sent`);
}

// ── Test 8: start()/stop() lifecycle ─────────────────────────────────────────

console.log('\n[Test 8] start/stop lifecycle — no further DB queries after stop');

{
  let pollCount = 0;
  const hm = new HealthMonitor({
    intervalMs: 10,
    deps: makeDeps({
      queryAgents: (_t) => { pollCount++; return []; },
    }),
  });

  hm.start();
  await new Promise(r => setTimeout(r, 55));
  hm.stop();
  const countAfterStop = pollCount;
  await new Promise(r => setTimeout(r, 40));
  assert(pollCount >= 3, `interval fired at least 3 times before stop (got ${pollCount})`);
  assert(pollCount === countAfterStop, `no new polls after stop() (${pollCount} === ${countAfterStop})`);
}

// ── Test 9: start() idempotency — second call does not add a second interval ──

console.log('\n[Test 9] start() idempotency: calling start() twice does not double the fire rate');

{
  let pollCount = 0;
  const hm = new HealthMonitor({
    intervalMs: 10,
    deps: makeDeps({
      queryAgents: (_t) => { pollCount++; return []; },
    }),
  });

  hm.start();
  hm.start(); // second call — must be a no-op
  await new Promise(r => setTimeout(r, 55));
  hm.stop();
  // If both intervals fired, pollCount would be ~10 not ~5
  assert(pollCount < 8, `calling start() twice does not double the fire rate (got ${pollCount})`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n=== TEST SUMMARY ===`);
console.log(`PASS: ${passed}  FAIL: ${failed}`);
if (failed > 0) process.exit(1);
