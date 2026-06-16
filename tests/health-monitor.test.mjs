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
    queryAgents:          (_threshold) => [],
    queryOrch:            (_threshold) => [],
    queryOrchSessions:    ()           => [],
    queryOrchIdleBlocked: (_minMs, _now) => [],
    queryBlockedWorkers:  ()           => [],
    getTmuxPane:          (_id)        => null,
    execFileSync:         ()           => {},
    readSynapseSettings:  () => ({}),
    sendMessage:          () => 0,
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

// ── Test 6: slot 0 excluded from worker query ─────────────────────────────────

console.log('\n[Test 6] Slot 0 (orchestrator) excluded by worker SQL query');

{
  const hm = new HealthMonitor({
    thresholdToolCalls: 300,
    deps: makeDeps({
      queryAgents: (_t) => [], // slot=0 filtered by slot > 0 in SQL
    }),
  });
  hm['_poll']();
  assert(hm.currentWarnings.size === 0, `orchestrator (slot=0) excluded — no worker warning`);
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
      // queryAgents is called twice per poll (threshold + compact-hint), so
      // pollCount tracks poll ticks, not individual queryAgents calls here.
      // Use a separate counter for the interval itself via queryOrchSessions.
      queryOrchSessions: () => { pollCount++; return []; },
    }),
  });

  hm.start();
  hm.start(); // second call — must be a no-op
  await new Promise(r => setTimeout(r, 55));
  hm.stop();
  assert(pollCount < 8, `calling start() twice does not double the fire rate (got ${pollCount})`);
}

// ── Test 9: MCP tools and Task counted in worker query ───────────────────────

console.log('\n[Test 9] COUNTED_TOOLS includes Task; MCP wildcard handled by SQL (mock returns row)');

{
  // The SQL wildcard is in the DB — here we verify the mock path:
  // if queryAgents returns a row (as the real SQL would for mcp__ tools), it shows up.
  const hm = new HealthMonitor({
    thresholdToolCalls: 10,
    deps: makeDeps({
      queryAgents: (_t) => [{
        agent_id: 'proj:5', role: 'developer', tool_call_count: 15, session_id: 'sess-mcp',
      }],
    }),
  });
  hm['_poll']();
  assert(hm.currentWarnings.has('proj:5'), `agent with MCP/Task tool calls appears in warnings`);
}

// ── Test 10: orch below threshold → orchWarnings empty ───────────────────────

console.log('\n[Test 10] Orch below threshold — orchWarnings empty');

{
  const hm = new HealthMonitor({
    orchThresholdToolCalls: 250,
    deps: makeDeps({
      queryOrch: (_t) => [],
    }),
  });
  hm['_poll']();
  assert(hm.orchWarnings.size === 0, `orchWarnings empty when orch below threshold`);
}

// ── Test 11: orch crosses threshold → orchWarnings set + bus message ──────────

console.log('\n[Test 11] Orch crosses threshold → orchWarnings set + sendMessage called');

{
  const sent = [];
  const hm = new HealthMonitor({
    orchThresholdToolCalls: 250,
    deps: makeDeps({
      queryOrch: (_t) => [{
        agent_id: 'proj:0', role: 'orchestrator', tool_call_count: 260, session_id: 'sess-orch',
      }],
      sendMessage: (from, to, content, prio) => { sent.push({ from, to, content, prio }); return 0; },
    }),
  });
  hm['_poll']();
  assert(hm.orchWarnings.has('proj:0'), `orchWarnings contains orch agent`);
  assert(sent.length === 1, `one bus message sent`);
  assert(sent[0].to === 'human', `message goes to human`);
  assert(sent[0].content.includes('[health]'), `message tagged [health]`);
  assert(sent[0].content.includes('260'), `message includes tool call count`);
}

// ── Test 12: orch threshold one-shot — does NOT re-send on next tick ──────────

console.log('\n[Test 12] Orch threshold one-shot: same condition does not re-send on next tick');

{
  const sent = [];
  const hm = new HealthMonitor({
    orchThresholdToolCalls: 250,
    deps: makeDeps({
      queryOrch: (_t) => [{
        agent_id: 'proj:0', role: 'orchestrator', tool_call_count: 260, session_id: 'sess-orch2',
      }],
      sendMessage: (from, to, content, prio) => { sent.push(content); return 0; },
    }),
  });
  hm['_poll']();
  hm['_poll']();
  hm['_poll']();
  assert(sent.length === 1, `sendMessage called only once for repeated threshold crossing (got ${sent.length})`);
}

// ── Test 13: orch idle while worker blocked ≥threshold → orchIdleBlocked set ──

console.log('\n[Test 13] Orch idle while worker blocked ≥ threshold → orchIdleBlocked + bus message with worker list');

{
  const sent = [];
  const hm = new HealthMonitor({
    idleBlockedThresholdMs: 60_000,
    deps: makeDeps({
      queryOrchIdleBlocked: (_minMs, _now) => [{ agent_id: 'proj:0' }],
      queryBlockedWorkers:  ()             => [{ agent_id: 'proj:3' }],
      sendMessage: (from, to, content, prio) => { sent.push({ to, content }); return 0; },
    }),
  });
  hm['_poll']();
  assert(hm.orchIdleBlocked.has('proj:0'), `orchIdleBlocked set`);
  assert(sent.length === 1, `one bus message sent`);
  assert(sent[0].to === 'human', `message goes to human`);
  assert(sent[0].content.includes('[health]'), `message tagged [health]`);
  assert(sent[0].content.includes('proj:3'), `message includes blocked worker agent_id`);
}

// ── Test 14: orch idle-blocked one-shot ──────────────────────────────────────

console.log('\n[Test 14] Orch idle-blocked one-shot: repeated condition does not re-send');

{
  const sent = [];
  const hm = new HealthMonitor({
    idleBlockedThresholdMs: 60_000,
    deps: makeDeps({
      queryOrchIdleBlocked: (_minMs, _now) => [{ agent_id: 'proj:0' }],
      sendMessage: (from, to, content, prio) => { sent.push(content); return 0; },
    }),
  });
  hm['_poll']();
  hm['_poll']();
  hm['_poll']();
  assert(sent.length === 1, `sendMessage called only once for repeated idle-blocked condition (got ${sent.length})`);
}

// ── Test 15: orch and worker queries are separate ─────────────────────────────

console.log('\n[Test 15] Worker query (slot > 0) separate from orch query (slot = 0)');

{
  const workerCalls = [];
  const orchCalls   = [];
  const hm = new HealthMonitor({
    thresholdToolCalls:     100,
    orchThresholdToolCalls: 200,
    deps: makeDeps({
      queryAgents: (t) => { workerCalls.push(t); return []; },
      queryOrch:   (t) => { orchCalls.push(t); return []; },
    }),
  });
  hm['_poll']();
  assert(workerCalls.length === 2, `worker query called twice (threshold + compact-hint)`);
  assert(orchCalls.length   === 1, `orch query called once`);
  assert(workerCalls[0] === 100, `worker uses worker threshold (100)`);
  assert(orchCalls[0]   === 200, `orch uses orch threshold (200)`);
}

// ── Test 16: settings keys override defaults ──────────────────────────────────

console.log('\n[Test 16] orchToolCallHint and idleBlockedThresholdMs override defaults');

{
  const orchThresholdsSeen = [];
  const idleMsSeen         = [];
  const hm = new HealthMonitor({
    orchThresholdToolCalls: 999, // should be overridden by settings
    idleBlockedThresholdMs: 999,
    deps: makeDeps({
      readSynapseSettings:  () => ({ orchToolCallHint: 300, idleBlockedThresholdMs: 45_000 }),
      queryOrch:            (t) => { orchThresholdsSeen.push(t); return []; },
      queryOrchIdleBlocked: (minMs, _now) => { idleMsSeen.push(minMs); return []; },
    }),
  });
  hm['_poll']();
  assert(orchThresholdsSeen[0] === 300, `orchToolCallHint=300 from settings overrides constructor default`);
  assert(idleMsSeen[0] === 45_000, `idleBlockedThresholdMs=45000 from settings overrides constructor default`);
}

// ── Test 17: Finding 1 regression — orch session changes while below threshold ─
// The stale-key bug: if orch restarts (new session) while count is below threshold,
// lastSeenOrchSession must still be updated so the next threshold crossing fires
// a fresh message.

console.log('\n[Test 17] Finding 1 regression: orch session change while below threshold → new message on next crossing');

{
  const sent = [];
  let orchSessionId = 'sess-old';
  let orchRowsAbove = [];

  const hm = new HealthMonitor({
    orchThresholdToolCalls: 250,
    deps: makeDeps({
      // queryOrchSessions always reflects current orch session (unconditional)
      queryOrchSessions: () => [{ agent_id: 'proj:0', session_id: orchSessionId }],
      queryOrch: (_t) => orchRowsAbove,
      sendMessage: (from, to, content) => { sent.push(content); return 0; },
    }),
  });

  // Tick 1: orch above threshold with old session → message sent
  orchRowsAbove = [{ agent_id: 'proj:0', role: 'orchestrator', tool_call_count: 260, session_id: 'sess-old' }];
  hm['_poll']();
  assert(sent.length === 1, `T17: first message sent on initial crossing`);

  // Tick 2: orch restarts — new session, count drops below threshold
  orchSessionId = 'sess-new';
  orchRowsAbove = []; // below threshold
  hm['_poll']();
  assert(sent.length === 1, `T17: no new message while below threshold`);

  // Tick 3: orch climbs above threshold again with NEW session
  orchRowsAbove = [{ agent_id: 'proj:0', role: 'orchestrator', tool_call_count: 270, session_id: 'sess-new' }];
  hm['_poll']();
  assert(sent.length === 2, `T17: second message sent after session-reset + new crossing (got ${sent.length})`);
}

// ── Test 18: Finding 2 — queryBlockedWorkers injected dep used in idle-blocked message ─

console.log('\n[Test 18] Finding 2: queryBlockedWorkers dep controls worker list in idle-blocked message');

{
  const sent = [];
  const hm = new HealthMonitor({
    idleBlockedThresholdMs: 60_000,
    deps: makeDeps({
      queryOrchIdleBlocked: () => [{ agent_id: 'proj:0' }],
      queryBlockedWorkers:  () => [{ agent_id: 'proj:7' }, { agent_id: 'proj:8' }],
      sendMessage: (_from, _to, content) => { sent.push(content); return 0; },
    }),
  });
  hm['_poll']();
  assert(sent.length === 1, `T18: message sent`);
  assert(sent[0].includes('proj:7'), `T18: first blocked worker in message`);
  assert(sent[0].includes('proj:8'), `T18: second blocked worker in message`);
}

// ── Test 19: Finding 3 regression — idle-blocked resets on orch session change ─

console.log('\n[Test 19] Finding 3 regression: idle-blocked fires again after orch session change');

{
  const sent = [];
  let orchSessionId = 'sess-a';

  const hm = new HealthMonitor({
    idleBlockedThresholdMs: 60_000,
    deps: makeDeps({
      queryOrchSessions:    () => [{ agent_id: 'proj:0', session_id: orchSessionId }],
      queryOrchIdleBlocked: () => [{ agent_id: 'proj:0' }],
      queryBlockedWorkers:  () => [{ agent_id: 'proj:2' }],
      sendMessage: (_from, _to, content) => { sent.push(content); return 0; },
    }),
  });

  // Tick 1: idle-blocked fires → message sent
  hm['_poll']();
  assert(sent.length === 1, `T19: first idle-blocked message sent`);

  // Tick 2: same session, same condition → no re-send
  hm['_poll']();
  assert(sent.length === 1, `T19: no re-send on same session (got ${sent.length})`);

  // Orch restarts with a new session
  orchSessionId = 'sess-b';

  // Tick 3: condition still true but new session → new message should fire
  hm['_poll']();
  assert(sent.length === 2, `T19: second message sent after orch session change (got ${sent.length})`);
}

// ── Test 20: auto-compact fires at half-threshold ─────────────────────────────

console.log('\n[Test 20] Auto-compact: fires tmux send-keys at half-threshold');

{
  const panes = { 'w:1': 'pane-1' };
  const tmuxCalls = [];
  const hm = new HealthMonitor({
    thresholdToolCalls: 200,
    deps: makeDeps({
      queryAgents: (t) => t <= 100
        ? [{ agent_id: 'w:1', role: 'developer', tool_call_count: 105, session_id: 'sess-a' }]
        : [],
      getTmuxPane: (id) => panes[id] ?? null,
      execFileSync: (cmd, args) => { tmuxCalls.push({ cmd, args }); },
    }),
  });
  hm['_poll']();
  assert(tmuxCalls.length === 1, `T20a: execFileSync called once`);
  assert(tmuxCalls[0]?.cmd === 'tmux', `T20b: command is tmux`);
  assert(
    JSON.stringify(tmuxCalls[0]?.args) === JSON.stringify(['send-keys', '-t', 'pane-1', '/compact', 'Enter']),
    `T20c: args are send-keys -t pane /compact Enter`,
  );
}

// ── Test 21: auto-compact fires only once per session ─────────────────────────

console.log('\n[Test 21] Auto-compact: does not fire again for same session');

{
  const tmuxCalls = [];
  const hm = new HealthMonitor({
    thresholdToolCalls: 200,
    deps: makeDeps({
      queryAgents: (t) => t <= 100
        ? [{ agent_id: 'w:1', role: 'developer', tool_call_count: 105, session_id: 'sess-a' }]
        : [],
      getTmuxPane: () => 'pane-1',
      execFileSync: () => { tmuxCalls.push(1); },
    }),
  });
  hm['_poll']();
  hm['_poll']();
  hm['_poll']();
  assert(tmuxCalls.length === 1, `T21: compact fired only once for same session (got ${tmuxCalls.length})`);
}

// ── Test 22: auto-compact re-arms after session rotation ─────────────────────

console.log('\n[Test 22] Auto-compact: re-arms after session rotation');

{
  let sessionId = 'sess-a';
  const tmuxCalls = [];
  const hm = new HealthMonitor({
    thresholdToolCalls: 200,
    deps: makeDeps({
      queryAgents: (t) => t <= 100
        ? [{ agent_id: 'w:1', role: 'developer', tool_call_count: 105, session_id: sessionId }]
        : [],
      getTmuxPane: () => 'pane-1',
      execFileSync: () => { tmuxCalls.push(sessionId); },
    }),
  });
  // Tick 1: fires for sess-a
  hm['_poll']();
  assert(tmuxCalls.length === 1, `T22a: compact fired for sess-a`);

  // Tick 2: same session — no second fire
  hm['_poll']();
  assert(tmuxCalls.length === 1, `T22b: no second fire same session`);

  // Session rotation
  sessionId = 'sess-b';

  // Tick 3: new session → fires again
  hm['_poll']();
  assert(tmuxCalls.length === 2, `T22c: compact fired again after session rotation (got ${tmuxCalls.length})`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n=== TEST SUMMARY ===`);
console.log(`PASS: ${passed}  FAIL: ${failed}`);
if (failed > 0) process.exit(1);
