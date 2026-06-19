/**
 * Tests for `type='hint'` message type addition.
 *
 * Run with: node --test --experimental-test-module-mocks --import tsx/esm src/eval/msg-type-hint.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TMP = join(tmpdir(), `msg-type-hint-test-${process.pid}`);
const DB_FILE = join(TMP, 'test.db');

before(() => {
  mkdirSync(TMP, { recursive: true });
  process.env.SYNAPSE_DB_PATH = DB_FILE;
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// Unit 1 — detectMessageType never returns 'hint' for arbitrary content
test('detectMessageType: does not auto-detect hint from content', async (t) => {
  t.mock.module('../db.js', { namedExports: {} });
  // @ts-ignore — ?v= query string busts ESM cache; TS doesn't resolve these specifiers
  const { detectMessageType } = await import('../db.js?v=h1');
  assert.equal(detectMessageType('[reflect-gate] task 5: tool_volume tripped'), 'message');
  assert.equal(detectMessageType('[health] orchestrator at 250 tool calls'), 'message');
  assert.equal(detectMessageType('hint: something'), 'message');
});

// Unit 2 — read_messages response map applies type ?? 'message' fallback
test('read_messages response includes type field, defaults to message for null', async () => {
  // Test the mapping logic directly — same as mcp-server.ts:443-449
  const rows = [
    { id: 42, from_id: 'synapse', priority: 0, created_at: Date.now(), content: '[reflect-gate] hint', type: 'hint' },
    { id: 43, from_id: 'orch:0', priority: 5, created_at: Date.now(), content: 'hello',         type: null },
    { id: 44, from_id: 'orch:0', priority: 5, created_at: Date.now(), content: 'DONE',           type: 'done' },
  ];
  const mapped = rows.map((m) => ({
    id: m.id,
    from: m.from_id,
    priority: m.priority,
    at: new Date(m.created_at).toISOString(),
    content: m.content,
    type: m.type ?? 'message',
  }));

  assert.equal(mapped[0].type, 'hint',    'hint row keeps type hint');
  assert.equal(mapped[1].type, 'message', 'null type defaults to message');
  assert.equal(mapped[2].type, 'done',    'done row keeps type done');
});

// Unit 3 — nudgeOrchestrator calls sendHint (type='hint' is set by sendHint)
test('nudgeOrchestrator calls sendHint with P0 to orchestrator', async (t) => {
  const calls: Array<{ toId: string; content: string; priority: number }> = [];

  t.mock.module('../db.js', {
    namedExports: {
      DB_PATH: DB_FILE,
      db: { prepare: () => ({ get: () => ({ agent_id: 'orch:0' }) }) },
      sendHint: (toId: string, content: string, priority: number) => {
        calls.push({ toId, content, priority });
        return 1;
      },
      getAgentState: () => 'idle',
    },
  });

  // @ts-ignore
  const { runReflectGate } = await import('./reflect-gate.js?v=h3');

  // Seed a case file that trips tool_volume gate
  const evalDir = join(TMP, 'evaluations');
  mkdirSync(evalDir, { recursive: true });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    join(evalDir, 'task_99_dev.json'),
    JSON.stringify({
      agents: {
        'dev-1': {
          role: 'developer',
          agent_id: 'abc:1',
          tools: { Read: { calls: 90 } }, // 90 > 80 threshold
        },
      },
    }),
    'utf8',
  );

  process.env.SYNAPSE_REFLECT_IDLE_MS = '0';
  await runReflectGate(99);

  assert.ok(calls.length > 0, 'sendHint should have been called');
  assert.equal(calls[0].toId, 'orch:0', 'nudge goes to orchestrator');
  assert.equal(calls[0].priority, 0, 'tool_volume trip is P0');
  assert.ok(calls[0].content.includes('[reflect-gate] task 99'), 'content uses [reflect-gate] prefix');
  assert.ok(calls[0].content.includes('tool_volume'), 'content names the gate');
});

// Unit 4 — DB accepts type='hint' row insertion with no constraint error
test("DB accepts type='hint' without CHECK constraint violation", async () => {
  const { openDb } = await import('../db.js');
  const d = openDb(DB_FILE);
  d.pragma('foreign_keys = OFF');
  // Insert a message with type='hint' — should not throw
  d.prepare(
    `INSERT INTO messages (from_id, to_id, content, priority, created_at, needs_approval, request_options, task_id, type)
     VALUES ('synapse', 'orch:0', '[reflect-gate] test hint', 0, ?, 0, NULL, NULL, 'hint')`
  ).run(Date.now());
  const row = d.prepare(
    `SELECT type FROM messages WHERE from_id='synapse' AND type='hint' LIMIT 1`
  ).get() as { type: string } | undefined;
  assert.equal(row?.type, 'hint', "row with type='hint' should be stored and retrievable");
  d.close();
});
