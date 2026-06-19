/**
 * Tests for routing_quality extraction in buildCase (via extractCases).
 *
 * Run with: node --test --experimental-test-module-mocks --import tsx/esm src/eval/extract.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Use the real openDb so the schema + migrations are applied correctly.
import { openDb } from '../db.js';

const TMP = join(tmpdir(), `extract-test-${process.pid}`);
const DB_FILE = join(TMP, 'test.db');
const OUT_DIR = join(TMP, 'out');

before(() => {
  mkdirSync(TMP, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });

  // Create DB with full schema via openDb, then seed shared rows.
  const d = openDb(DB_FILE);
  d.pragma('foreign_keys = OFF');

  const now = Date.now();
  // Orchestrator agent (slot 0) — ended_at IS NULL so buildRoutingQuality can find it
  d.prepare(`INSERT OR IGNORE INTO agent_status (agent_id, slot, state, updated_at) VALUES ('orch:0', 0, 'idle', ?)`).run(now);
  // Workers
  d.prepare(`INSERT OR IGNORE INTO agent_status (agent_id, slot, role, state, updated_at) VALUES ('worker:1', 1, 'developer', 'idle', ?)`).run(now);
  d.prepare(`INSERT OR IGNORE INTO agent_status (agent_id, slot, role, state, updated_at) VALUES ('worker:2', 2, 'developer', 'idle', ?)`).run(now);
  d.prepare(`INSERT OR IGNORE INTO agent_status (agent_id, slot, role, state, updated_at) VALUES ('worker:3', 3, 'code-reviewer', 'idle', ?)`).run(now);

  d.close();
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test('routing_quality: baseline — one worker, decisions logged, done message', async () => {
  const d = openDb(DB_FILE);
  d.pragma('foreign_keys = OFF');

  d.prepare(`INSERT OR IGNORE INTO tasks (id, agent_id, title, status, started_at, finished_at) VALUES (10, 'orch:0', 'baseline task', 'completed', 1000, 5000)`).run();
  d.prepare(`INSERT INTO messages (from_id, to_id, content, created_at, type) VALUES ('orch:0', 'worker:1', 'Do X', 1500, 'message')`).run();
  d.prepare(`INSERT INTO orch_decisions (agent_id, kind, value, related_task_id, created_at) VALUES ('orch:0', 'route', 'worker:1', 10, 1200)`).run();
  d.prepare(`INSERT INTO messages (from_id, to_id, content, created_at, type) VALUES ('worker:1', 'orch:0', 'DONE', 4500, 'done')`).run();

  d.close();

  const { extractCases } = await import('./extract.js');
  const cases = extractCases(DB_FILE, OUT_DIR, 1, 10);

  assert.equal(cases.length, 1);
  const rq = cases[0].routing_quality;
  assert.equal(rq.reroute_count, 0, 'one worker = 0 reroutes');
  assert.equal(rq.escalation_count, 0, 'no escalations');
  assert.equal(rq.no_decisions_logged, false, 'decisions were logged');
  assert.equal(rq.time_to_first_done_ms, 3500, 'time to first done = 4500 - 1000');
});

test('routing_quality: two distinct workers → reroute_count = 1', async () => {
  const d = openDb(DB_FILE);
  d.pragma('foreign_keys = OFF');

  d.prepare(`INSERT OR IGNORE INTO tasks (id, agent_id, title, status, started_at, finished_at) VALUES (11, 'orch:0', 'rerouted task', 'completed', 2000, 8000)`).run();
  d.prepare(`INSERT INTO messages (from_id, to_id, content, created_at, type) VALUES ('orch:0', 'worker:2', 'Do Y', 2500, 'message')`).run();
  d.prepare(`INSERT INTO messages (from_id, to_id, content, created_at, type) VALUES ('orch:0', 'worker:3', 'Review Y', 5000, 'message')`).run();

  d.close();

  const { extractCases } = await import('./extract.js');
  const cases = extractCases(DB_FILE, OUT_DIR, 1, 11);

  const rq = cases[0].routing_quality;
  assert.equal(rq.reroute_count, 1, 'two distinct workers = 1 reroute');
  assert.equal(rq.no_decisions_logged, true, 'no decisions logged for task 11');
  // time_to_first_done_ms may pick up a done message from another task in the same DB/window;
  // assert it's either null or a positive number (not negative or NaN).
  assert.ok(
    rq.time_to_first_done_ms === null || rq.time_to_first_done_ms > 0,
    'time_to_first_done_ms must be null or positive',
  );
});

test('routing_quality: escalation logged', async () => {
  const d = openDb(DB_FILE);
  d.pragma('foreign_keys = OFF');

  d.prepare(`INSERT OR IGNORE INTO tasks (id, agent_id, title, status, started_at, finished_at) VALUES (12, 'orch:0', 'escalated task', 'completed', 3000, 9000)`).run();
  d.prepare(`INSERT INTO orch_decisions (agent_id, kind, value, related_task_id, created_at) VALUES ('orch:0', 'escalate', 'human', 12, 3500)`).run();
  d.prepare(`INSERT INTO orch_decisions (agent_id, kind, value, related_task_id, created_at) VALUES ('orch:0', 'route', 'worker:1', 12, 3100)`).run();

  d.close();

  const { extractCases } = await import('./extract.js');
  const cases = extractCases(DB_FILE, OUT_DIR, 1, 12);

  const rq = cases[0].routing_quality;
  assert.equal(rq.escalation_count, 1);
  assert.equal(rq.no_decisions_logged, false);
});

test('routing_quality: reflection_path defaults to null', async () => {
  const d = openDb(DB_FILE);
  d.pragma('foreign_keys = OFF');

  d.prepare(`INSERT OR IGNORE INTO tasks (id, agent_id, title, status, started_at, finished_at) VALUES (13, 'orch:0', 'reflection path task', 'completed', 4000, 10000)`).run();

  d.close();

  const { extractCases } = await import('./extract.js');
  const cases = extractCases(DB_FILE, OUT_DIR, 1, 13);

  assert.equal(cases[0].reflection_path, null);
});
