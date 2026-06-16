#!/usr/bin/env node
/**
 * Tests for getAllToolMetrics() session filtering.
 * Run: node tests/tool-metrics-session.test.mjs
 *
 * Uses an in-memory SQLite DB (SYNAPSE_DB_PATH=:memory:) to avoid touching
 * the real database.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Point at in-memory DB before importing db.ts (which initialises the schema on import)
process.env.SYNAPSE_DB_PATH = ':memory:';

const dbModule = await import(join(ROOT, 'dist', 'db.js'));
const { db: testDb, getAllToolMetrics, ingestEvent } = dbModule;

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

// ── Helpers ──────────────────────────────────────────────────────────────────

function registerAgent(agentId, slot, sessionId) {
  testDb.prepare(`
    INSERT OR REPLACE INTO agent_status (agent_id, slot, state, session_id, updated_at, ended_at)
    VALUES (?, ?, 'idle', ?, ?, NULL)
  `).run(agentId, slot, sessionId, Date.now());
}

function endAgent(agentId) {
  testDb.prepare(`UPDATE agent_status SET ended_at = ? WHERE agent_id = ?`).run(Date.now(), agentId);
}

let evtSeq = 0;
function addToolCall(agentId, sessionId, tool) {
  evtSeq++;
  ingestEvent({
    id: `evt_${evtSeq}`,
    event: `tool:after:${tool}`,
    sessionId,
    timestamp: Date.now() + evtSeq,
    durationMs: 10,
    payload: { tool, status: 'ok' },
  });
}

// ── Test 1: basic session filter — only live session rows returned ─────────────

console.log('\n[Test 1] Only tool calls in the current live session are returned');

{
  registerAgent('p:1', 1, 'sess-live');

  // Add calls in the live session
  addToolCall('p:1', 'sess-live', 'Read');
  addToolCall('p:1', 'sess-live', 'Read');
  addToolCall('p:1', 'sess-live', 'Bash');

  // Add old calls under a different (past) session — same agent_id, different session_id
  // These must NOT appear since agent_status.session_id = 'sess-live'
  addToolCall('p:1', 'sess-old', 'Write');
  addToolCall('p:1', 'sess-old', 'Edit');

  const metrics = getAllToolMetrics().filter(m => m.synapse_agent_id === 'p:1');
  const readRow = metrics.find(m => m.tool === 'Read');
  const bashRow = metrics.find(m => m.tool === 'Bash');
  const writeRow = metrics.find(m => m.tool === 'Write');
  const editRow  = metrics.find(m => m.tool === 'Edit');

  assert(readRow?.calls === 2, `Read: 2 calls from live session (got ${readRow?.calls})`);
  assert(bashRow?.calls === 1, `Bash: 1 call from live session (got ${bashRow?.calls})`);
  assert(writeRow == null, `Write: old-session row excluded (got ${writeRow?.calls})`);
  assert(editRow  == null, `Edit: old-session row excluded (got ${editRow?.calls})`);
}

// ── Test 2: agent with ended_at set yields no rows ────────────────────────────

console.log('\n[Test 2] Agent with ended_at set → no rows returned');

{
  registerAgent('p:2', 2, 'sess-ended');
  addToolCall('p:2', 'sess-ended', 'Glob');
  addToolCall('p:2', 'sess-ended', 'Glob');

  // Verify rows exist before ending
  const before = getAllToolMetrics().filter(m => m.synapse_agent_id === 'p:2');
  assert(before.length > 0, `rows present before agent ended (${before.length})`);

  endAgent('p:2');

  const after = getAllToolMetrics().filter(m => m.synapse_agent_id === 'p:2');
  assert(after.length === 0, `no rows after agent ended (ended_at set)`);
}

// ── Test 3: session rotation clears bar (restart semantics) ──────────────────

console.log('\n[Test 3] Session rotation (restart): old session calls drop out, new session starts at 0');

{
  registerAgent('p:3', 3, 'sess-before-restart');
  addToolCall('p:3', 'sess-before-restart', 'WebFetch');
  addToolCall('p:3', 'sess-before-restart', 'WebFetch');

  const before = getAllToolMetrics().filter(m => m.synapse_agent_id === 'p:3');
  assert(before.find(m => m.tool === 'WebFetch')?.calls === 2, `2 WebFetch calls before restart`);

  // Simulate restart: agent_status.session_id rotates to a new value
  testDb.prepare(`UPDATE agent_status SET session_id = ? WHERE agent_id = 'p:3'`)
    .run('sess-after-restart');

  // Old tool_metrics rows still exist in DB but no longer match the JOIN
  const afterRotate = getAllToolMetrics().filter(m => m.synapse_agent_id === 'p:3');
  assert(afterRotate.length === 0, `bar cleared after session rotation (${afterRotate.length} rows)`);

  // New call in new session appears
  addToolCall('p:3', 'sess-after-restart', 'Read');
  const afterNew = getAllToolMetrics().filter(m => m.synapse_agent_id === 'p:3');
  assert(afterNew.find(m => m.tool === 'Read')?.calls === 1, `new session: 1 Read call visible`);
  assert(afterNew.find(m => m.tool === 'WebFetch') == null, `old WebFetch calls not visible in new session`);
}

// ── Test 4: multiple agents — each agent isolated to its own session ──────────

console.log('\n[Test 4] Multiple agents each show only their own session calls');

{
  registerAgent('p:4', 4, 'sess-a4');
  registerAgent('p:5', 5, 'sess-a5');

  addToolCall('p:4', 'sess-a4', 'Edit');
  addToolCall('p:4', 'sess-a4', 'Edit');
  addToolCall('p:4', 'sess-a4', 'Edit');
  addToolCall('p:5', 'sess-a5', 'Bash');
  addToolCall('p:5', 'sess-a5', 'Bash');

  const m4 = getAllToolMetrics().filter(m => m.synapse_agent_id === 'p:4');
  const m5 = getAllToolMetrics().filter(m => m.synapse_agent_id === 'p:5');

  assert(m4.find(m => m.tool === 'Edit')?.calls === 3, `p:4 Edit: 3 calls`);
  assert(m5.find(m => m.tool === 'Bash')?.calls === 2, `p:5 Bash: 2 calls`);
  assert(m4.find(m => m.tool === 'Bash') == null, `p:4 has no Bash rows`);
  assert(m5.find(m => m.tool === 'Edit') == null, `p:5 has no Edit rows`);
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n=== TEST SUMMARY ===`);
console.log(`PASS: ${passed}  FAIL: ${failed}`);
if (failed > 0) process.exit(1);
