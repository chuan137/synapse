#!/usr/bin/env node
/**
 * Eval v2/v3 unit tests.
 * Run: node tests/eval-v2.test.mjs
 *
 * Tests:
 *   1. Extractor C3 output shape (schema_version: 3, message_snippets, tool_metrics.summary, anti_patterns)
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

// ── Test 1: C3 extractor output shape ────────────────────────────────────────

console.log('\n[Test 1] Extractor C3 output shape');

const caseFiles = readdirSync(CASES_DIR).filter(f => f.endsWith('.json'));
assert(caseFiles.length > 0, `Cases directory has at least 1 file (found ${caseFiles.length})`);

// Check a multi-agent case (task 102 has both developer and orchestrator)
const multiAgentFile = join(CASES_DIR, 'task_102_good.json');
if (existsSync(multiAgentFile)) {
  const c = JSON.parse(readFileSync(multiAgentFile, 'utf8'));

  assert(c.schema_version === 3, `task_102: schema_version === 3`);
  assert(c.raw === undefined, `task_102: raw field absent (dropped in C3)`);
  assert(Array.isArray(c.messages) === false || c.messages === undefined, `task_102: top-level messages array absent`);

  // message_snippets shape
  assert(Array.isArray(c.message_snippets), `task_102: message_snippets is array`);
  assert(c.message_snippets.length <= 5, `task_102: message_snippets.length <= 5`);
  if (c.message_snippets.length > 0) {
    const s = c.message_snippets[0];
    assert(typeof s.from === 'string', `task_102: snippet.from is string`);
    assert(typeof s.to === 'string',   `task_102: snippet.to is string`);
    assert(typeof s.content_200 === 'string', `task_102: snippet.content_200 is string`);
    assert(s.content_200.length <= 200, `task_102: snippet.content_200 <= 200 chars`);
  }

  // tool_metric_ids
  assert(Array.isArray(c.tool_metric_ids), `task_102: tool_metric_ids is array`);

  // tool_metrics.summary shape
  assert(c.tool_metrics !== undefined, `task_102: tool_metrics present`);
  assert(typeof c.tool_metrics.summary === 'object', `task_102: tool_metrics.summary is object`);
  assert(typeof c.tool_metrics.summary.total_calls === 'number', `task_102: summary.total_calls is number`);
  assert(typeof c.tool_metrics.summary.by_tool === 'object', `task_102: summary.by_tool is object`);
  assert(typeof c.tool_metrics.summary.duration_total_ms === 'number', `task_102: summary.duration_total_ms is number`);
  assert(typeof c.tool_metrics.summary.error_rate === 'number', `task_102: summary.error_rate is number`);
  assert(Array.isArray(c.tool_metrics.ids), `task_102: tool_metrics.ids is array`);

  // anti_patterns shape
  const ap = c.tool_metrics.summary.anti_patterns;
  assert(ap !== undefined, `task_102: anti_patterns present`);
  assert(typeof ap.repeat_reads === 'object' && !Array.isArray(ap.repeat_reads), `task_102: anti_patterns.repeat_reads is object`);
  assert(Array.isArray(ap.read_no_edit), `task_102: anti_patterns.read_no_edit is array`);
  assert(typeof ap.bash_repeats === 'object' && !Array.isArray(ap.bash_repeats), `task_102: anti_patterns.bash_repeats is object`);
  assert(typeof ap.edit_retries === 'object' && !Array.isArray(ap.edit_retries), `task_102: anti_patterns.edit_retries is object`);
  assert(typeof ap.read_per_turn_max === 'number', `task_102: anti_patterns.read_per_turn_max is number`);

  // agents still present
  assert(c.agents !== undefined, `task_102: agents map present`);
  assert(Object.keys(c.agents).length >= 1, `task_102: at least one agent entry`);
  const firstAgent = Object.values(c.agents)[0];
  assert(typeof firstAgent.agent_id === 'string', `task_102: agent.agent_id is string`);
  assert(typeof firstAgent.role === 'string', `task_102: agent.role is string`);
  assert(typeof firstAgent.messages_in === 'number', `task_102: agent.messages_in is number`);
  assert(typeof firstAgent.messages_out === 'number', `task_102: agent.messages_out is number`);
  assert(Array.isArray(firstAgent.blocked_events), `task_102: agent.blocked_events is array`);

  assert(Array.isArray(c.blocked_events), `task_102: top-level blocked_events is array`);
  assert(Array.isArray(c.linked_msg_ids), `task_102: linked_msg_ids is array`);

  for (const key of Object.keys(c.agents)) {
    assert(key.includes(':'), `task_102: agent key '${key}' contains ':'`);
  }
} else {
  console.log('  ⚠ task_102_good.json not found — skipping shape checks');
  failed++;
}

// Spot-check a few more cases have schema_version: 3
const sample = caseFiles.slice(0, 5);
for (const f of sample) {
  const c = JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8'));
  assert(c.schema_version === 3, `${f}: schema_version === 3`);
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
