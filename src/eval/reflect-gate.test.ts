/**
 * Tests for reflect-gate: Unit 1 (checkToolVolumeGate), Unit 2 (checkIdleGate
 * probabilistic math), Unit 3 (runReflectGate early-exit / gate routing).
 *
 * Run with: node --test --experimental-test-module-mocks --import tsx/esm src/eval/reflect-gate.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TMP = join(tmpdir(), `reflect-gate-test-${process.pid}`);

function writeCaseFile(name: string, data: unknown): string {
  mkdirSync(TMP, { recursive: true });
  const p = join(TMP, name);
  writeFileSync(p, JSON.stringify(data), 'utf8');
  return p;
}

const THRESHOLDS_DATA = {
  by_role: { _default: { tool_calls_p90: 80 } },
  reflect_gate: { idle_drift: { p_base: 0.1, p_max: 0.6, softFloor: 0.5, aggregation: 'max' } },
};

before(() => {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(join(TMP, 'thresholds.json'), JSON.stringify(THRESHOLDS_DATA), 'utf8');
  process.env.SYNAPSE_DB_PATH = join(TMP, 'test.db');
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// Each test appends a unique ?v=N query string to bust the ESM module cache
// so t.mock.module() takes effect per-test rather than being shadowed by the
// first import that landed in the registry.

// ── Unit 1 — checkToolVolumeGate(caseFilePath) ────────────────────────────────

test('Unit 1 — gate-1: below threshold → null', async (t) => {
  t.mock.module('../db.js', {
    namedExports: {
      DB_PATH: join(TMP, 'test.db'),
      db: { prepare: () => ({ get: () => null }) },
      sendMessage: () => {},
      getAgentState: () => null,
    },
  });

  // @ts-ignore — ?v= query string busts ESM cache; TS doesn't resolve these specifiers
  const { checkToolVolumeGate } = await import('./reflect-gate.js?v=1');

  const caseFile = writeCaseFile('case_below.json', {
    agents: {
      'dev-1': {
        role: 'developer',
        agent_id: 'abc:1',
        tools: { Read: { calls: 15 }, Edit: { calls: 10 }, Bash: { calls: 5 } }, // total=30, threshold=80
      },
    },
  });
  assert.equal(checkToolVolumeGate(caseFile), null);
});

test('Unit 1 — gate-1: above threshold → GateTrip', async (t) => {
  t.mock.module('../db.js', {
    namedExports: {
      DB_PATH: join(TMP, 'test.db'),
      db: { prepare: () => ({ get: () => null }) },
      sendMessage: () => {},
      getAgentState: () => null,
    },
  });

  // @ts-ignore — ?v= query string busts ESM cache; TS doesn't resolve these specifiers
  const { checkToolVolumeGate } = await import('./reflect-gate.js?v=2');

  const caseFile = writeCaseFile('case_above.json', {
    agents: {
      'dev-1': {
        role: 'developer',
        agent_id: 'abc:1',
        tools: { Read: { calls: 50 }, Edit: { calls: 40 } }, // total=90 > 80
      },
    },
  });
  const trip = checkToolVolumeGate(caseFile);
  assert.ok(trip, 'expected a GateTrip');
  assert.equal(trip!.gate, 'tool_volume');
  assert.match(trip!.reason, /tool_calls=90/);
});

test('Unit 1 — gate-1: v1 fallback above threshold → GateTrip', async (t) => {
  t.mock.module('../db.js', {
    namedExports: {
      DB_PATH: join(TMP, 'test.db'),
      db: { prepare: () => ({ get: () => null }) },
      sendMessage: () => {},
      getAgentState: () => null,
    },
  });

  // @ts-ignore — ?v= query string busts ESM cache; TS doesn't resolve these specifiers
  const { checkToolVolumeGate } = await import('./reflect-gate.js?v=3');

  const caseFile = writeCaseFile('case_v1_above.json', {
    metrics: { tool_calls: 90 },
  });
  const trip = checkToolVolumeGate(caseFile);
  assert.ok(trip, 'expected a GateTrip via v1 fallback');
  assert.equal(trip!.gate, 'tool_volume');
});

test('Unit 1 — gate-1: v1 fallback below threshold → null', async (t) => {
  t.mock.module('../db.js', {
    namedExports: {
      DB_PATH: join(TMP, 'test.db'),
      db: { prepare: () => ({ get: () => null }) },
      sendMessage: () => {},
      getAgentState: () => null,
    },
  });

  // @ts-ignore — ?v= query string busts ESM cache; TS doesn't resolve these specifiers
  const { checkToolVolumeGate } = await import('./reflect-gate.js?v=4');

  const caseFile = writeCaseFile('case_v1_below.json', {
    metrics: { tool_calls: 10 },
  });
  assert.equal(checkToolVolumeGate(caseFile), null);
});

// ── Unit 2 — checkIdleGate probabilistic math ────────────────────────────────

test('Unit 2 — idle-drift: always-fire RNG + orch idle → GateTrip', async (t) => {
  t.mock.module('../db.js', {
    namedExports: {
      DB_PATH: join(TMP, 'test.db'),
      db: { prepare: () => ({ get: () => null }) },
      sendMessage: () => {},
      getAgentState: (_id: string) => 'idle',
    },
  });

  // @ts-ignore — ?v= query string busts ESM cache; TS doesn't resolve these specifiers
  const { checkIdleGate } = await import('./reflect-gate.js?v=5');

  const caseFile = writeCaseFile('idle_base.json', { agents: {}, tool_metrics: {} });
  // rng=0.0, soft1=soft2=0 → p=p_base=0.1 > 0.0 → fires
  const trip = await checkIdleGate(caseFile, 'orch:0', () => 0.0, 0);
  assert.ok(trip, 'expected GateTrip with always-fire RNG and idle orch');
  assert.equal(trip!.gate, 'idle_drift');
});

test('Unit 2 — idle-drift: never-fire RNG → null', async (t) => {
  t.mock.module('../db.js', {
    namedExports: {
      DB_PATH: join(TMP, 'test.db'),
      db: { prepare: () => ({ get: () => null }) },
      sendMessage: () => {},
      getAgentState: (_id: string) => 'idle',
    },
  });

  // @ts-ignore — ?v= query string busts ESM cache; TS doesn't resolve these specifiers
  const { checkIdleGate } = await import('./reflect-gate.js?v=6');

  const caseFile = writeCaseFile('idle_never.json', { agents: {}, tool_metrics: {} });
  // rng=1.0 → never fires regardless of p
  const trip = await checkIdleGate(caseFile, 'orch:0', () => 1.0, 0);
  assert.equal(trip, null);
});

test('Unit 2 — idle-drift: f=1.0, rng just below p_max → GateTrip', async (t) => {
  t.mock.module('../db.js', {
    namedExports: {
      DB_PATH: join(TMP, 'test.db'),
      db: { prepare: () => ({ get: () => null }) },
      sendMessage: () => {},
      getAgentState: (_id: string) => 'idle',
    },
  });

  // @ts-ignore — ?v= query string busts ESM cache; TS doesn't resolve these specifiers
  const { checkIdleGate } = await import('./reflect-gate.js?v=7');

  // soft1=1.0: calls=80 == threshold=80 → (80/80 - 0.5) / 0.5 = 1.0; p_max=0.6, rng=0.59 < 0.6 → fires
  const caseFile = writeCaseFile('idle_f1_below.json', {
    agents: {
      'dev-1': {
        role: '_default',
        agent_id: 'abc:1',
        tools: { Read: { calls: 80 } },
      },
    },
    tool_metrics: {},
  });
  const trip = await checkIdleGate(caseFile, 'orch:0', () => 0.59, 0);
  assert.ok(trip, 'expected GateTrip when rng just below p_max');
  assert.equal(trip!.gate, 'idle_drift');
});

test('Unit 2 — idle-drift: f=1.0, rng just above p_max → null', async (t) => {
  t.mock.module('../db.js', {
    namedExports: {
      DB_PATH: join(TMP, 'test.db'),
      db: { prepare: () => ({ get: () => null }) },
      sendMessage: () => {},
      getAgentState: (_id: string) => 'idle',
    },
  });

  // @ts-ignore — ?v= query string busts ESM cache; TS doesn't resolve these specifiers
  const { checkIdleGate } = await import('./reflect-gate.js?v=8');

  const caseFile = writeCaseFile('idle_f1_above.json', {
    agents: {
      'dev-1': {
        role: '_default',
        agent_id: 'abc:1',
        tools: { Read: { calls: 80 } },
      },
    },
    tool_metrics: {},
  });
  // p_max=0.6, rng=0.61 > 0.6 → does not fire
  const trip = await checkIdleGate(caseFile, 'orch:0', () => 0.61, 0);
  assert.equal(trip, null);
});

test('Unit 2 — idle-drift: RNG fires but orch not idle → null', async (t) => {
  t.mock.module('../db.js', {
    namedExports: {
      DB_PATH: join(TMP, 'test.db'),
      db: { prepare: () => ({ get: () => null }) },
      sendMessage: () => {},
      getAgentState: (_id: string) => 'working', // not idle
    },
  });

  // @ts-ignore — ?v= query string busts ESM cache; TS doesn't resolve these specifiers
  const { checkIdleGate } = await import('./reflect-gate.js?v=9');

  const caseFile = writeCaseFile('idle_orch_busy.json', { agents: {}, tool_metrics: {} });
  // rng fires (0.0 < p_base=0.1), but orch is working
  const trip = await checkIdleGate(caseFile, 'orch:0', () => 0.0, 0);
  assert.equal(trip, null);
});

// ── Unit 3 — runReflectGate early-exit and routing ───────────────────────────

test('Unit 3 — no case file → early-exit, no idle sleep', async (t) => {
  t.mock.module('../db.js', {
    namedExports: {
      DB_PATH: join(TMP, 'test.db'),
      db: { prepare: () => ({ get: () => ({ agent_id: 'orch:0' }) }) },
      sendMessage: () => {},
      getAgentState: () => 'idle',
    },
  });

  process.env.SYNAPSE_REFLECT_IDLE_MS = '0';

  // @ts-ignore — ?v= query string busts ESM cache; TS doesn't resolve these specifiers
  const { runReflectGate } = await import('./reflect-gate.js?v=10');

  // Task ID 999999 — no matching case file in TMP/evaluations/
  const start = Date.now();
  await runReflectGate(999999);
  // waitForCaseFile polls for CASE_POLL_TIMEOUT_MS (15s) before returning null.
  // We accept the 15s poll as "early exit" — the key is it does NOT then sleep
  // IDLE_GATE_DELAY_MS (3 min) on top of that. With Fix #2 total wall time is
  // ~15s; without Fix #2 it would be ~3m15s. Keep timeout generous enough for
  // CI but well below the zombie duration (we don't override CASE_POLL_TIMEOUT_MS).
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 60_000, `runReflectGate took ${elapsed}ms — expected no idle-drift sleep`);
});

test('Unit 3 — gate-1 trips → nudgeOrchestrator called for tool_volume', async (t) => {
  const nudged: string[] = [];

  t.mock.module('../db.js', {
    namedExports: {
      DB_PATH: join(TMP, 'test.db'),
      db: { prepare: () => ({ get: () => ({ agent_id: 'orch:0' }) }) },
      sendMessage: (_from: string, _to: string, content: string) => { nudged.push(content); },
      getAgentState: () => 'idle',
    },
  });

  process.env.SYNAPSE_REFLECT_IDLE_MS = '0';

  // Write a case file for task 2 with high tool_calls
  mkdirSync(join(TMP, 'evaluations'), { recursive: true });
  writeFileSync(
    join(TMP, 'evaluations', 'task_2_abc.json'),
    JSON.stringify({
      agents: {
        'dev-1': {
          role: 'developer',
          agent_id: 'abc:1',
          tools: { Read: { calls: 50 }, Edit: { calls: 40 } }, // 90 > 80
        },
      },
    }),
    'utf8',
  );

  // @ts-ignore — ?v= query string busts ESM cache; TS doesn't resolve these specifiers
  const { runReflectGate } = await import('./reflect-gate.js?v=11');
  await runReflectGate(2);

  assert.ok(nudged.length > 0, 'expected nudgeOrchestrator to be called');
  assert.ok(nudged[0].includes('tool_volume'), 'expected tool_volume gate trip');
});
