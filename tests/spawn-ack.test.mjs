#!/usr/bin/env node
/**
 * Tests for spawn ACK enforcement (ready_at / setAgentReady / getAgentReady / delegate_task gate).
 * Run: node tests/spawn-ack.test.mjs
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Import db helpers — uses the actual DB (SYNAPSE_DB_PATH or .synapse/synapse.db)
const { db: testDb, setAgentReady: testSetReady, getAgentReady: testGetReady, listLiveWorkers } =
  await import(join(ROOT, 'dist', 'db.js'));

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

// Use a high slot number unlikely to clash with real agents
const TEST_AGENT_ID = 'test-spawn-ack:97';
const TEST_AGENT_ID2 = 'test-spawn-ack:98';
const now = Date.now();

// ── Setup: register test agents ───────────────────────────────────────────────

testDb.prepare(`
  INSERT OR REPLACE INTO agent_status (agent_id, slot, state, current_task, updated_at, ready_at)
  VALUES (?, 97, 'idle', NULL, ?, NULL)
`).run(TEST_AGENT_ID, now);

testDb.prepare(`
  INSERT OR REPLACE INTO agent_status (agent_id, slot, state, current_task, updated_at, ready_at)
  VALUES (?, 98, 'idle', NULL, ?, NULL)
`).run(TEST_AGENT_ID2, now);

// ── Test 1: Fresh agent is not ready ─────────────────────────────────────────

console.log('\n[Test 1] Fresh agent has ready_at = null');

const ready = testGetReady(TEST_AGENT_ID);
assert(ready === null, `getAgentReady returns null for fresh agent`);

// ── Test 2: setAgentReady marks agent ready ───────────────────────────────────

console.log('\n[Test 2] setAgentReady marks agent as ready');

testSetReady(TEST_AGENT_ID);
const readyAfter = testGetReady(TEST_AGENT_ID);
assert(readyAfter !== null, `getAgentReady returns non-null after setAgentReady`);
assert(typeof readyAfter === 'number', `getAgentReady returns a number (epoch ms)`);
assert(readyAfter <= Date.now(), `ready_at is not in the future`);
assert(readyAfter >= now - 1000, `ready_at is recent`);

// ── Test 3: setAgentReady is idempotent ───────────────────────────────────────

console.log('\n[Test 3] setAgentReady is idempotent');

const first = testGetReady(TEST_AGENT_ID);
await new Promise(r => setTimeout(r, 20));
testSetReady(TEST_AGENT_ID);
const second = testGetReady(TEST_AGENT_ID);
assert(first === second, `second setAgentReady does not change ready_at`);

// ── Test 4: listLiveWorkers includes ready field ──────────────────────────────

console.log('\n[Test 4] listLiveWorkers includes ready and ready_age');

const workers = listLiveWorkers();
const w = workers.find(w => w.agent_id === TEST_AGENT_ID);
assert(w !== undefined, `test agent appears in listLiveWorkers`);
assert(w?.ready === true, `worker.ready = true after setAgentReady`);
assert(typeof w?.ready_age === 'string', `worker.ready_age is a string`);
assert(w?.ready_age.startsWith('ready'), `ready_age starts with "ready"`);

// ── Test 5: Unready agent shows not ready in listLiveWorkers ──────────────────

console.log('\n[Test 5] Unready agent shows "not ready" in listLiveWorkers');

const workers2 = listLiveWorkers();
const w2 = workers2.find(w => w.agent_id === TEST_AGENT_ID2);
assert(w2 !== undefined, `unready test agent appears in listLiveWorkers`);
assert(w2?.ready === false, `worker.ready = false for fresh unready agent`);
assert(w2?.ready_age === 'not ready', `ready_age = "not ready"`);

// ── Test 6: getAgentReady returns null for unknown agent ─────────────────────

console.log('\n[Test 6] getAgentReady returns null for unknown agent');

const unknownReady = testGetReady('nonexistent:999');
assert(unknownReady === null, `getAgentReady(unknown) = null`);

// ── Cleanup ───────────────────────────────────────────────────────────────────

testDb.prepare(`DELETE FROM agent_status WHERE agent_id IN (?, ?)`).run(TEST_AGENT_ID, TEST_AGENT_ID2);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n=== TEST SUMMARY ===`);
console.log(`PASS: ${passed}  FAIL: ${failed}`);
if (failed > 0) process.exit(1);
