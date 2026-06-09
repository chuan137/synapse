#!/usr/bin/env node
/**
 * Tests for eval window report.
 * Run: node tests/eval-window.test.mjs
 *
 * Uses a temporary SQLite DB with synthetic tasks and tool_metrics.
 */

import { strictEqual, ok } from 'assert';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { parseDuration, generateWindowReport } = await import(join(ROOT, 'dist', 'eval', 'window.js'));
const { default: Database } = await import('better-sqlite3');
const { openDb } = await import(join(ROOT, 'dist', 'db.js'));

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

// ── Test 1: Duration parser ───────────────────────────────────────────────────

console.log('\n[Test 1] Duration parser');

assert(parseDuration('24h')  === 86_400_000,   `24h = 86400000ms`);
assert(parseDuration('7d')   === 604_800_000,  `7d = 604800000ms`);
assert(parseDuration('2w')   === 1_209_600_000,`2w = 1209600000ms`);
assert(parseDuration('30m')  === 1_800_000,    `30m = 1800000ms`);
assert(parseDuration('1000ms') === 1000,       `1000ms = 1000ms`);
assert(parseDuration('60s')  === 60_000,       `60s = 60000ms`);

let threw = false;
try { parseDuration('bad'); } catch { threw = true; }
assert(threw, `parseDuration('bad') throws`);

// ── Setup: temp DB with synthetic tasks ──────────────────────────────────────

const tmpDbPath = join(ROOT, '.synapse', 'test-window-temp.db');
const testDb = openDb(tmpDbPath);  // runs migrations

const now = Date.now();
const HOUR = 3_600_000;

// Register agents
testDb.prepare(`INSERT OR REPLACE INTO agent_status (agent_id, slot, state, current_task, updated_at, role)
  VALUES ('proj:1', 1, 'idle', NULL, ?, 'developer')`).run(now);
testDb.prepare(`INSERT OR REPLACE INTO agent_status (agent_id, slot, state, current_task, updated_at, role)
  VALUES ('proj:2', 2, 'idle', NULL, ?, 'code-reviewer')`).run(now);

// Three tasks in window (last 24h)
testDb.prepare(`INSERT OR IGNORE INTO tasks (id, agent_id, title, status, started_at, finished_at, commit_sha)
  VALUES (9001, 'proj:1', 'Fix auth bug', 'completed', ?, ?, 'abc1')`).run(now - 2*HOUR, now - HOUR);
testDb.prepare(`INSERT OR IGNORE INTO tasks (id, agent_id, title, status, started_at, finished_at, commit_sha)
  VALUES (9002, 'proj:1', 'Fix login form', 'completed', ?, ?, 'abc2')`).run(now - 3*HOUR, now - 2*HOUR);
testDb.prepare(`INSERT OR IGNORE INTO tasks (id, agent_id, title, status, started_at, finished_at, commit_sha)
  VALUES (9003, 'proj:2', 'Review auth code', 'completed', ?, ?, NULL)`).run(now - HOUR, now - 10*60*1000);

// One task OUTSIDE the 2h window (older than 24h)
testDb.prepare(`INSERT OR IGNORE INTO tasks (id, agent_id, title, status, started_at, finished_at)
  VALUES (9000, 'proj:1', 'Old task', 'completed', ?, ?)`).run(now - 48*HOUR, now - 25*HOUR);

// Add tool_metrics with direct FK
for (let i = 0; i < 10; i++) {
  testDb.prepare(`INSERT OR IGNORE INTO tool_metrics (event_id, synapse_agent_id, session_id, tool, status, duration_ms, timestamp, task_id)
    VALUES (?, 'proj:1', 'sess1', 'Read', 'ok', ?, ?, 9001)`).run(`evt_9001_${i}`, 50 + i, now - HOUR - i*1000);
}
for (let i = 0; i < 5; i++) {
  testDb.prepare(`INSERT OR IGNORE INTO tool_metrics (event_id, synapse_agent_id, session_id, tool, status, duration_ms, timestamp, task_id)
    VALUES (?, 'proj:1', 'sess1', 'Bash', ?, ?, ?, 9002)`).run(`evt_9002_${i}`, i === 2 ? 'error' : 'ok', 200, now - 2.5*HOUR - i*1000);
}

// ── Test 2: Aggregation correctness ──────────────────────────────────────────

console.log('\n[Test 2] Aggregation correctness');

const report24h = generateWindowReport(tmpDbPath, { since: '24h' });

assert(report24h.includes('Tasks completed: 3'), `3 completed tasks in 24h window`);
assert(!report24h.includes('Old task'), `old task excluded from window`);
assert(report24h.includes('developer'), `developer role present in report`);
assert(report24h.includes('code-reviewer'), `code-reviewer role present in report`);

// task 9001 has 10 Read calls (all FK-attributed)
assert(report24h.includes('Read'), `Read tool appears in tool usage`);

// task 9002 has 1 Bash error out of 5 calls = 20% error rate — should show
assert(report24h.includes('Bash'), `Bash tool appears`);

// commits: 9001 + 9002 have commits (2); 9003 does not
assert(report24h.includes('Total commits: 2'), `2 commits in window`);

// ── Test 3: Empty window ──────────────────────────────────────────────────────

console.log('\n[Test 3] Empty window returns no-activity report');

const emptyReport = generateWindowReport(tmpDbPath, {
  from: now - 100,
  to: now - 50,
});
assert(emptyReport.includes('No completed tasks'), `empty window returns no-activity message`);
assert(emptyReport.split('\n').length <= 5, `empty report is short (≤5 lines)`);

// ── Test 4: Role filter ───────────────────────────────────────────────────────

console.log('\n[Test 4] Role filter');

const devReport = generateWindowReport(tmpDbPath, { since: '24h', role: 'developer' });
assert(devReport.includes('developer'), `developer role present when filtered`);
assert(!devReport.includes('code-reviewer'), `code-reviewer absent when filtering for developer`);
assert(devReport.includes('Tasks completed: 2'), `2 developer tasks in 24h`);

// ── Test 5: Idle drift signal ─────────────────────────────────────────────────

console.log('\n[Test 5] Idle drift flag appears for high-ratio tasks');

// task 9003: long wall-clock (50 min), no tool_metrics → ratio very high
assert(report24h.includes('9003'), `task 9003 appears in idle drift table`);

// ── Cleanup ───────────────────────────────────────────────────────────────────

try { rmSync(tmpDbPath); } catch { /* ignore */ }

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n=== TEST SUMMARY ===`);
console.log(`PASS: ${passed}  FAIL: ${failed}`);
if (failed > 0) process.exit(1);
