#!/usr/bin/env node
/**
 * Eval v2 unit tests.
 * Run: node tests/eval-v2.test.mjs
 *
 * Tests:
 *   1. Extractor v2 output shape (schema_version, agents, blocked_events, raw)
 *   2. Calibrate: thresholds.json generated; roles with <3 samples are skipped
 *   3. Evaluator regression: all good cases pass, all bad cases fail
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
// Raw cases: .synapse/cases/ (gitignored, full corpus). Tests/cases/ is the curated set (may be empty).
const CASES_DIR = existsSync(join(ROOT, '.synapse', 'cases'))
  ? join(ROOT, '.synapse', 'cases')
  : join(ROOT, 'tests', 'cases');
const THRESHOLDS_PATH = join(ROOT, 'src', 'eval', 'thresholds.json');

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

// ── Test 1: v2 extractor output shape ────────────────────────────────────────

console.log('\n[Test 1] Extractor v2 output shape');

const caseFiles = readdirSync(CASES_DIR).filter(f => f.endsWith('.json'));
assert(caseFiles.length > 0, `Cases directory has at least 1 file (found ${caseFiles.length})`);

// Check a multi-agent case (task 102 has both developer and orchestrator)
const multiAgentFile = join(CASES_DIR, 'task_102_good.json');
if (existsSync(multiAgentFile)) {
  const c = JSON.parse(readFileSync(multiAgentFile, 'utf8'));

  assert(c.schema_version === 2, `task_102: schema_version === 2`);
  assert(typeof c.task_id === 'number', `task_102: task_id is a number`);
  assert(c.agents !== undefined, `task_102: agents map present`);
  assert(Object.keys(c.agents).length >= 1, `task_102: at least one agent entry`);

  // Check AgentTrajectory shape on first agent
  const firstAgent = Object.values(c.agents)[0];
  assert(typeof firstAgent.agent_id === 'string', `task_102: agent.agent_id is string`);
  assert(typeof firstAgent.role === 'string', `task_102: agent.role is string`);
  assert(typeof firstAgent.tools === 'object', `task_102: agent.tools is object`);
  assert(typeof firstAgent.messages_in === 'number', `task_102: agent.messages_in is number`);
  assert(typeof firstAgent.messages_out === 'number', `task_102: agent.messages_out is number`);
  assert(typeof firstAgent.active_duration_ms === 'number', `task_102: agent.active_duration_ms is number`);
  assert(Array.isArray(firstAgent.blocked_events), `task_102: agent.blocked_events is array`);

  // Check ToolStats shape on any tool entry
  const toolEntries = Object.values(firstAgent.tools);
  if (toolEntries.length > 0) {
    const ts = toolEntries[0];
    assert(typeof ts.calls === 'number', `task_102: tool.calls is number`);
    assert(typeof ts.avg_ms === 'number', `task_102: tool.avg_ms is number`);
    assert(typeof ts.p90_ms === 'number', `task_102: tool.p90_ms is number`);
    assert(typeof ts.errors === 'number', `task_102: tool.errors is number`);
    assert(typeof ts.error_rate === 'number', `task_102: tool.error_rate is number`);
    assert(ts.error_rate >= 0 && ts.error_rate <= 1, `task_102: tool.error_rate in [0,1]`);
  }

  // Check blocked_events array (task-level)
  assert(Array.isArray(c.blocked_events), `task_102: top-level blocked_events is array`);

  // Check raw backwards-compat
  assert(c.raw !== undefined, `task_102: raw field present`);
  assert(Array.isArray(c.raw.messages), `task_102: raw.messages is array`);
  assert(Array.isArray(c.raw.tool_metrics), `task_102: raw.tool_metrics is array`);

  // Check that agents key format is "<role>:<slot>"
  for (const key of Object.keys(c.agents)) {
    assert(key.includes(':'), `task_102: agent key '${key}' contains ':'`);
  }
} else {
  console.log('  ⚠ task_102_good.json not found — skipping shape checks');
  failed++;
}

// Spot-check a few more cases have schema_version: 2
const sample = caseFiles.slice(0, 5);
for (const f of sample) {
  const c = JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8'));
  assert(c.schema_version === 2, `${f}: schema_version === 2`);
}

// ── Test 2: Calibrate output ──────────────────────────────────────────────────

console.log('\n[Test 2] Calibrate: thresholds.json content and sample-size guard');

assert(existsSync(THRESHOLDS_PATH), `thresholds.json exists at ${THRESHOLDS_PATH}`);

if (existsSync(THRESHOLDS_PATH)) {
  const t = JSON.parse(readFileSync(THRESHOLDS_PATH, 'utf8'));

  assert(typeof t.calibrated_at === 'string', `thresholds: calibrated_at is string`);
  assert(typeof t.sample_size === 'object', `thresholds: sample_size is object`);
  assert(typeof t.by_role === 'object', `thresholds: by_role is object`);
  assert(t.task_level?.traceability_score_max !== undefined, `thresholds: task_level.traceability_score_max present`);

  // Verify every role in by_role has sample_size >= 3
  for (const [role, threshold] of Object.entries(t.by_role)) {
    const n = t.sample_size[role] ?? 0;
    assert(n >= 3, `thresholds: role '${role}' has sample_size ${n} >= 3`);
    assert(threshold.tool_calls_p90 !== undefined, `thresholds: role '${role}' has tool_calls_p90`);
    assert(threshold.duration_ms_p90 !== undefined, `thresholds: role '${role}' has duration_ms_p90`);
    assert(threshold.error_rate_max !== undefined, `thresholds: role '${role}' has error_rate_max`);
  }

  // No role with sample_size < 3 should appear in by_role
  for (const [role, n] of Object.entries(t.sample_size)) {
    if (n < 3) {
      assert(t.by_role[role] === undefined, `thresholds: role '${role}' with n=${n} absent from by_role (below min-3 threshold)`);
    }
  }
}

// ── Test 3: Evaluator regression ─────────────────────────────────────────────

console.log('\n[Test 3] Evaluator regression: good cases pass, bad cases fail');

// Dynamically import the evaluator (ES module)
const { evaluateCases } = await import(join(ROOT, 'dist', 'eval', 'evaluator.js'));
const results = evaluateCases(CASES_DIR);

const goodCases = results.filter(r => r.label === 'good');
const badCases  = results.filter(r => r.label === 'bad');

// All labelled-good cases should pass
const goodFails = goodCases.filter(r => !r.pass);
assert(goodFails.length === 0, `All good-labelled cases pass (${goodCases.length} total, ${goodFails.length} unexpected fails)`);
if (goodFails.length > 0) {
  goodFails.forEach(r => console.error(`    unexpected fail: #${r.id} ${r.title.slice(0, 40)}`));
}

// All labelled-bad cases should fail
const badPasses = badCases.filter(r => r.pass);
assert(badPasses.length === 0, `No bad-labelled cases pass (${badCases.length} total, ${badPasses.length} unexpected passes)`);
if (badPasses.length > 0) {
  badPasses.forEach(r => console.error(`    unexpected pass: #${r.id} ${r.title.slice(0, 40)}`));
}

// Every EvalResult has the expected shape
for (const r of results.slice(0, 5)) {
  assert(Array.isArray(r.failures), `result #${r.id}: failures is array`);
  assert(Array.isArray(r.soft_failures), `result #${r.id}: soft_failures is array`);
  if (r.failures.length > 0) {
    const f = r.failures[0];
    assert(typeof f.agent_id === 'string', `result #${r.id}: failure.agent_id is string`);
    assert(typeof f.role === 'string', `result #${r.id}: failure.role is string`);
    assert(typeof f.metric === 'string', `result #${r.id}: failure.metric is string`);
  }
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n=== TEST SUMMARY ===`);
console.log(`PASS: ${passed}  FAIL: ${failed}`);
if (failed > 0) process.exit(1);
