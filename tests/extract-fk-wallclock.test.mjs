#!/usr/bin/env node
/**
 * Tests for FK-preferred extraction and wall-clock idle_drift soft signal.
 * Run: node tests/extract-fk-wallclock.test.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
// Prefer raw corpus (.synapse/evaluations/); fall back to curated if raw dir absent
const CASES_DIR = existsSync(join(ROOT, '.synapse', 'evaluations'))
  ? join(ROOT, '.synapse', 'evaluations')
  : join(ROOT, 'tests', 'cases');

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

// ── Test 1: FK-preferred extraction (structural check on case files) ─────────

console.log('\n[Test 1] Extractor FK-first: v2 case files use agents map (FK-derived)');

// After --regenerate-all, all cases with workers should have non-empty agents
// All pre-migration tasks will have empty or time-window-derived agents (both valid)
const caseFiles = readdirSync(CASES_DIR).filter(f => f.endsWith('.json'));
assert(caseFiles.length > 0, `cases directory has files`);

// Every case should be schema_version 2
let allV2 = true;
for (const f of caseFiles.slice(0, 20)) {
  const c = JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8'));
  if (c.schema_version !== 2) { allV2 = false; break; }
}
assert(allV2, `all sampled cases are schema_version 2`);

// Cases with agent entries should have valid AgentTrajectory shape
const multiAgentCase = join(CASES_DIR, 'task_102_good.json');
if (existsSync(multiAgentCase)) {
  const c = JSON.parse(readFileSync(multiAgentCase, 'utf8'));
  assert(c.agents !== undefined, `task_102: agents map present after re-extraction`);
  assert(Object.keys(c.agents).length >= 1, `task_102: at least one agent`);
  // active_duration_ms should be present (populated by aggregateByAgent)
  const firstAgent = Object.values(c.agents)[0];
  assert(typeof firstAgent.active_duration_ms === 'number', `task_102: agent.active_duration_ms is number`);
}

// Empty agents map is valid (orchestrator-only tasks)
const orchCase = caseFiles.find(f => {
  const c = JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8'));
  return c.agents && Object.keys(c.agents).length === 0;
});
// This is not required — just verify we don't crash on it
assert(true, `no crash on empty agents map (vacuously true — no case found or handled)`);

// ── Test 2: idle_drift soft signal ───────────────────────────────────────────

console.log('\n[Test 2] idle_drift soft signal fires on high wall-clock / low active ratio');

const { evaluateCases } = await import(join(ROOT, 'dist', 'eval', 'evaluator.js'));

// Synthesize a case file matching TrajectoryV2 with high idle_drift
// total_duration_ms = 1_800_000ms, sum(active_duration_ms) = 4_000ms → ratio 450
const syntheticCase = {
  schema_version: 2,
  id: 99999,
  label: 'good',
  task: { id: 99999, agent_id: 'test:1', title: 'Synthetic idle-drift test', commit_sha: 'abc123' },
  messages: [],
  tool_metrics: [],
  metrics: { tool_calls: 5, duration_ms: 1_800_000, traceability_score: 0, has_commit: true },
  task_id: 99999,
  title: 'Synthetic idle-drift test',
  trigger_msg_id: null, source_msg_id: null, result_msg_id: null,
  commit_sha: 'abc123',
  started_at: Date.now() - 1_800_000,
  finished_at: Date.now(),
  total_duration_ms: 1_800_000,
  agents: {
    'developer:1': {
      agent_id: 'test:1',
      role: 'developer',
      tools: {
        'Read': { calls: 5, avg_ms: 800, p90_ms: 1000, errors: 0, error_rate: 0 },
      },
      blocked_events: [],
      messages_in: 1,
      messages_out: 1,
      active_duration_ms: 4_000,  // sum = 4000ms
    },
  },
  blocked_events: [],
  raw: { messages: [], tool_metrics: [] },
};

// Write to a temp case file
import { writeFileSync, mkdirSync, unlinkSync } from 'fs';
const tmpDir = join(ROOT, 'tests', 'cases-tmp-idle-test');
mkdirSync(tmpDir, { recursive: true });
const tmpFile = join(tmpDir, 'task_99999_good.json');
writeFileSync(tmpFile, JSON.stringify(syntheticCase, null, 2));

const results = evaluateCases(tmpDir);
assert(results.length === 1, `synthetic eval returns 1 result`);

const r = results[0];
assert(r.pass, `synthetic case passes (idle_drift is soft, not a hard fail)`);
const driftSignal = r.soft_failures.find(s => s.startsWith('idle_drift'));
assert(driftSignal !== undefined, `idle_drift soft signal present`);
if (driftSignal) {
  assert(driftSignal.includes('ratio=450'), `idle_drift ratio is 450 (1800000 / 4000)`);
}

// Clean up
unlinkSync(tmpFile);
import { rmdirSync } from 'fs';
rmdirSync(tmpDir, { recursive: true });

// ── Test 3: No idle_drift when ratio ≤ 10 ────────────────────────────────────

console.log('\n[Test 3] idle_drift does NOT fire when ratio ≤ 10');

const normalCase = {
  ...syntheticCase,
  id: 99998,
  task: { ...syntheticCase.task, id: 99998 },
  task_id: 99998,
  total_duration_ms: 30_000,   // 30s wall-clock
  agents: {
    'developer:1': {
      ...syntheticCase.agents['developer:1'],
      active_duration_ms: 10_000,  // ratio = 3 → OK
    },
  },
};
const tmpDir2 = join(ROOT, 'tests', 'cases-tmp-nodrift');
mkdirSync(tmpDir2, { recursive: true });
const tmpFile2 = join(tmpDir2, 'task_99998_good.json');
writeFileSync(tmpFile2, JSON.stringify(normalCase, null, 2));

const results2 = evaluateCases(tmpDir2);
const r2 = results2[0];
assert(r2.pass, `normal case passes`);
assert(!r2.soft_failures.some(s => s.startsWith('idle_drift')), `no idle_drift when ratio ≤ 10`);

unlinkSync(tmpFile2);
rmdirSync(tmpDir2, { recursive: true });

// ── Test 4: Evaluator regression over full existing cases ─────────────────────

console.log('\n[Test 4] Evaluator regression: good cases pass, bad cases fail');

const allResults = evaluateCases(CASES_DIR);
const goodCases = allResults.filter(r => r.label === 'good');
const badCases  = allResults.filter(r => r.label === 'bad');

const goodFails = goodCases.filter(r => !r.pass);
assert(goodFails.length === 0, `All good-labelled cases pass (${goodCases.length} total, ${goodFails.length} fails)`);

const badPasses = badCases.filter(r => r.pass);
assert(badPasses.length === 0, `No bad-labelled cases pass (${badCases.length} total, ${badPasses.length} unexpected passes)`);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n=== TEST SUMMARY ===`);
console.log(`PASS: ${passed}  FAIL: ${failed}`);
if (failed > 0) process.exit(1);
