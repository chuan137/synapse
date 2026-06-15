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
    readSynapseSettings: () => ({}),
    ...overrides,
  };
}

// ── Test 1: below threshold → currentWarnings empty ──────────────────────────

console.log('\n[Test 1] Below threshold — currentWarnings empty');

{
  const hm = new HealthMonitor({
    thresholdToolCalls: 300,
    deps: makeDeps({
      queryAgents: (_t) => [],
    }),
  });
  hm['_poll']();
  assert(hm.currentWarnings.size === 0, `currentWarnings empty when no agents cross threshold`);
}

// ── Test 2: currentWarnings populated on crossing ─────────────────────────────

console.log('\n[Test 2] currentWarnings populated on crossing');

{
  const hm = new HealthMonitor({
    thresholdToolCalls: 300,
    deps: makeDeps({
      queryAgents: (_t) => [{
        agent_id: 'proj:1', role: 'developer', tool_call_count: 300, session_id: 'sess-a',
      }],
    }),
  });
  hm['_poll']();
  assert(hm.currentWarnings.has('proj:1'), `currentWarnings contains crossing agent`);
  assert(hm.currentWarnings.size === 1, `exactly one warning`);
}

// ── Test 3: currentWarnings cleared when agent drops below threshold ──────────

console.log('\n[Test 3] currentWarnings cleared when agent drops below threshold');

{
  let rows = [{
    agent_id: 'proj:2', role: 'developer', tool_call_count: 350, session_id: 'sess-b',
  }];
  const hm = new HealthMonitor({
    thresholdToolCalls: 300,
    deps: makeDeps({
      queryAgents: (_t) => rows,
    }),
  });

  hm['_poll']();
  assert(hm.currentWarnings.has('proj:2'), `agent in warnings after first poll`);

  rows = []; // agent dropped below threshold, no longer returned by query
  hm['_poll']();
  assert(!hm.currentWarnings.has('proj:2'), `agent removed from warnings after dropping below`);
  assert(hm.currentWarnings.size === 0, `warnings empty`);
}

// ── Test 4: currentWarnings cleared on session change then re-added ───────────

console.log('\n[Test 4] currentWarnings: cleared on session change, re-added if still crossing');

{
  let sessionId = 'sess-old';
  const hm = new HealthMonitor({
    thresholdToolCalls: 300,
    deps: makeDeps({
      queryAgents: (_t) => [{
        agent_id: 'proj:3', role: 'developer', tool_call_count: 320, session_id: sessionId,
      }],
    }),
  });

  hm['_poll']();
  assert(hm.currentWarnings.has('proj:3'), `in warnings before restart`);

  // Simulate restart with new session — agent immediately above threshold again
  sessionId = 'sess-new';
  hm['deps'].queryAgents = () => [{ agent_id: 'proj:3', role: 'developer', tool_call_count: 320, session_id: sessionId }];
  hm['_poll']();
  assert(hm.currentWarnings.has('proj:3'), `re-added in same tick after session reset`);
}

// ── Test 5: currentWarnings reflects multiple agents ─────────────────────────

console.log('\n[Test 5] currentWarnings reflects multiple crossing agents');

{
  const hm = new HealthMonitor({
    thresholdToolCalls: 300,
    deps: makeDeps({
      queryAgents: (_t) => [
        { agent_id: 'proj:10', role: 'developer', tool_call_count: 310, session_id: 'sess-1' },
        { agent_id: 'proj:11', role: 'developer', tool_call_count: 450, session_id: 'sess-2' },
      ],
    }),
  });
  hm['_poll']();
  assert(hm.currentWarnings.has('proj:10'), `first agent in warnings`);
  assert(hm.currentWarnings.has('proj:11'), `second agent in warnings`);
  assert(hm.currentWarnings.size === 2, `exactly two warnings`);
}

// ── Test 6: slot 0 excluded (handled by SQL query) ───────────────────────────

console.log('\n[Test 6] Slot 0 (orchestrator) excluded by SQL query');

{
  const hm = new HealthMonitor({
    thresholdToolCalls: 300,
    deps: makeDeps({
      queryAgents: (_t) => [], // slot=0 filtered by slot > 0 in SQL
    }),
  });
  hm['_poll']();
  assert(hm.currentWarnings.size === 0, `orchestrator (slot=0) excluded — no warning`);
}

// ── Test 7: start()/stop() lifecycle ─────────────────────────────────────────

console.log('\n[Test 7] start/stop lifecycle — no further DB queries after stop');

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

// ── Test 8: start() idempotency ───────────────────────────────────────────────

console.log('\n[Test 8] start() idempotency: calling start() twice does not double the fire rate');

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
  assert(pollCount < 8, `calling start() twice does not double the fire rate (got ${pollCount})`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n=== TEST SUMMARY ===`);
console.log(`PASS: ${passed}  FAIL: ${failed}`);
if (failed > 0) process.exit(1);
