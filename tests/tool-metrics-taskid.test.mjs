#!/usr/bin/env node
/**
 * Tests for task_id attribution on tool_metrics via worker cookie.
 * Run: node tests/tool-metrics-taskid.test.mjs
 *
 * Uses an in-memory SQLite DB (SYNAPSE_DB_PATH=:memory:) to avoid touching
 * the real database.
 */

import { strictEqual, ok } from 'assert';

// Use a temp in-memory DB so tests are isolated
process.env.SYNAPSE_DB_PATH = ':memory:';

const { default: Database } = await import('better-sqlite3');
const db = new Database(':memory:');

// Bootstrap schema by importing openDb on the in-memory path
// (we re-point SYNAPSE_DB_PATH but the module's default `db` uses the path at import time,
//  so we test via direct db access after ensuring migrations ran)
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Import the helpers we want to test
const dbModule = await import(join(ROOT, 'dist', 'db.js'));
const {
  setCurrentTaskId,
  clearCurrentTaskId,
  clearCurrentTaskIdForTask,
  ingestEvent,
  claimAgentSlot,
} = dbModule;

// The module's `db` singleton is pointed at whatever SYNAPSE_DB_PATH was at import time.
// We need to reach into it to run queries. We use the exported `db` (if exposed) or
// query via the helpers. Since `db` is exported, use it.
const { db: testDb } = dbModule;

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

// ── Setup: register two test agents ─────────────────────────────────────────

// Register worker agent (slot ≥ 1)
testDb.prepare(`
  INSERT OR IGNORE INTO agent_status (agent_id, slot, state, current_task, updated_at)
  VALUES ('test-project:1', 1, 'idle', NULL, ?)
`).run(Date.now());

// Register orchestrator (slot 0)
testDb.prepare(`
  INSERT OR IGNORE INTO agent_status (agent_id, slot, state, current_task, updated_at)
  VALUES ('test-project:0', 0, 'idle', NULL, ?)
`).run(Date.now());

// Register a task
testDb.prepare(`
  INSERT OR IGNORE INTO tasks (id, agent_id, title, status, started_at)
  VALUES (999, 'test-project:1', 'Test task', 'in_progress', ?)
`).run(Date.now());

// Map session IDs to agents (needed for ingestEvent)
testDb.prepare(`UPDATE agent_status SET session_id = 'sess-worker-001' WHERE agent_id = 'test-project:1'`).run();
testDb.prepare(`UPDATE agent_status SET session_id = 'sess-orch-001'   WHERE agent_id = 'test-project:0'`).run();

// ── Test 1: setCurrentTaskId ─────────────────────────────────────────────────

console.log('\n[Test 1] setCurrentTaskId writes correctly');

setCurrentTaskId('test-project:1', 999);
const row1 = testDb.prepare(`SELECT current_task_id FROM agent_status WHERE agent_id = 'test-project:1'`).get();
assert(row1?.current_task_id === 999, `worker current_task_id = 999 after setCurrentTaskId`);

const row0 = testDb.prepare(`SELECT current_task_id FROM agent_status WHERE agent_id = 'test-project:0'`).get();
assert(row0?.current_task_id === null, `orchestrator current_task_id unchanged (still NULL)`);

// ── Test 2: tool:after ingest writes task_id for worker ──────────────────────

console.log('\n[Test 2] tool:after ingest: worker row gets task_id, orchestrator row gets NULL');

const workerEvent = {
  id: 'evt_test_worker_001',
  event: 'tool:after:Read',
  sessionId: 'sess-worker-001',
  timestamp: Date.now(),
  durationMs: 42,
  payload: { tool: 'Read', status: 'ok' },
};
ingestEvent(workerEvent);

const workerMetric = testDb.prepare(`SELECT task_id FROM tool_metrics WHERE event_id = 'evt_test_worker_001'`).get();
assert(workerMetric !== undefined, `worker tool_metrics row inserted`);
assert(workerMetric?.task_id === 999, `worker tool_metrics.task_id = 999`);

const orchEvent = {
  id: 'evt_test_orch_001',
  event: 'tool:after:Bash',
  sessionId: 'sess-orch-001',
  timestamp: Date.now(),
  durationMs: 100,
  payload: { tool: 'Bash', status: 'ok' },
};
ingestEvent(orchEvent);

const orchMetric = testDb.prepare(`SELECT task_id FROM tool_metrics WHERE event_id = 'evt_test_orch_001'`).get();
assert(orchMetric !== undefined, `orchestrator tool_metrics row inserted`);
assert(orchMetric?.task_id === null, `orchestrator tool_metrics.task_id = NULL`);

// ── Test 3: clearCurrentTaskId (report_done path) ────────────────────────────

console.log('\n[Test 3] clearCurrentTaskId clears worker cookie');

clearCurrentTaskId('test-project:1');
const row1b = testDb.prepare(`SELECT current_task_id FROM agent_status WHERE agent_id = 'test-project:1'`).get();
assert(row1b?.current_task_id === null, `worker current_task_id = NULL after clearCurrentTaskId`);

// ── Test 4: tool:after after clear → task_id NULL ────────────────────────────

console.log('\n[Test 4] tool:after with no cookie → task_id NULL');

const workerEvent2 = {
  id: 'evt_test_worker_002',
  event: 'tool:after:Edit',
  sessionId: 'sess-worker-001',
  timestamp: Date.now() + 1,
  durationMs: 55,
  payload: { tool: 'Edit', status: 'ok' },
};
ingestEvent(workerEvent2);

const workerMetric2 = testDb.prepare(`SELECT task_id FROM tool_metrics WHERE event_id = 'evt_test_worker_002'`).get();
assert(workerMetric2 !== undefined, `second worker tool_metrics row inserted`);
assert(workerMetric2?.task_id === null, `second worker tool_metrics.task_id = NULL (no cookie)`);

// ── Test 5: clearCurrentTaskIdForTask (finish_task safety net) ───────────────

console.log('\n[Test 5] clearCurrentTaskIdForTask clears all agents holding that task');

// Set cookie again to simulate a second worker that hasn't reported done
testDb.prepare(`
  INSERT OR IGNORE INTO agent_status (agent_id, slot, state, current_task, updated_at)
  VALUES ('test-project:2', 2, 'working', NULL, ?)
`).run(Date.now());
testDb.prepare(`UPDATE agent_status SET current_task_id = 999 WHERE agent_id = 'test-project:2'`).run();
testDb.prepare(`UPDATE agent_status SET current_task_id = 999 WHERE agent_id = 'test-project:1'`).run();

clearCurrentTaskIdForTask(999);

const r1 = testDb.prepare(`SELECT current_task_id FROM agent_status WHERE agent_id = 'test-project:1'`).get();
const r2 = testDb.prepare(`SELECT current_task_id FROM agent_status WHERE agent_id = 'test-project:2'`).get();
assert(r1?.current_task_id === null, `worker :1 current_task_id cleared by clearCurrentTaskIdForTask`);
assert(r2?.current_task_id === null, `worker :2 current_task_id cleared by clearCurrentTaskIdForTask`);
assert(row0?.current_task_id === null, `orchestrator :0 unaffected`);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n=== TEST SUMMARY ===`);
console.log(`PASS: ${passed}  FAIL: ${failed}`);
if (failed > 0) process.exit(1);
