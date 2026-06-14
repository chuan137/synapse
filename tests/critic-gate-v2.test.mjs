#!/usr/bin/env node
/**
 * Tests for critic + gate v2.
 * Run: node tests/critic-gate-v2.test.mjs
 *
 * Tests use mocked Anthropic responses (no real API calls).
 */

import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { parsePatchMeta, buildPatchFrontmatter, roleToTemplateFile } = await import(join(ROOT, 'dist', 'eval', 'patch.js'));
const { evaluateCases } = await import(join(ROOT, 'dist', 'eval', 'evaluator.js'));

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

// ── Setup: temp dirs ──────────────────────────────────────────────────────────

const tmpDir     = join(ROOT, 'tests', 'critic-gate-tmp');
const patchDir   = join(tmpDir, 'patches');
const gateDir    = join(tmpDir, 'gate');
const casesDir   = join(tmpDir, 'cases');
const rulesFile  = join(tmpDir, 'SYNAPSE-worker.md');

mkdirSync(patchDir, { recursive: true });
mkdirSync(gateDir, { recursive: true });
mkdirSync(casesDir, { recursive: true });
writeFileSync(rulesFile, '# Worker rules\n\nAlways call report_done when finished.\n');

// Synthetic C3 case that fails (developer with too many tool calls)
const failCase = {
  schema_version: 3,
  id: 77777,
  label: 'good',
  task: { id: 77777, agent_id: 'proj:1', title: 'Fix auth bug', commit_sha: 'abc123', source_msg_id: 1, trigger_msg_id: 2, result_msg_id: null },
  linked_msg_ids: [1, 2],
  tool_metric_ids: [],
  message_snippets: [
    { from: 'proj:0', to: 'proj:1', content_200: 'Fix the auth bug.' },
    { from: 'proj:1', to: 'proj:0', content_200: 'DONE — fixed.' },
  ],
  metrics: { tool_calls: 200, duration_ms: 120000, traceability_score: 1, has_commit: true },
  title: 'Fix auth bug',
  started_at: 1000,
  finished_at: 2000,
  total_duration_ms: 120000,
  agents: {
    'developer:1': {
      agent_id: 'proj:1',
      role: 'developer',
      tools: {
        'Read': { calls: 80, avg_ms: 90, p90_ms: 120, errors: 0, error_rate: 0 },
        'Bash': { calls: 70, avg_ms: 800, p90_ms: 1200, errors: 5, error_rate: 0.07 },
        'Edit': { calls: 50, avg_ms: 200, p90_ms: 300, errors: 0, error_rate: 0 },
      },
      blocked_events: [],
      messages_in: 1,
      messages_out: 1,
      active_duration_ms: 45000,
    },
  },
  blocked_events: [],
  tool_metrics: {
    summary: {
      total_calls: 200,
      by_tool: {
        'Read': { count: 80, ok: 80, err: 0, avg_ms: 90, max_ms: 200, p95_ms: 180 },
        'Bash': { count: 70, ok: 65, err: 5, avg_ms: 800, max_ms: 2000, p95_ms: 1800 },
        'Edit': { count: 50, ok: 50, err: 0, avg_ms: 200, max_ms: 400, p95_ms: 380 },
      },
      duration_total_ms: 90000,
      error_rate: 0.025,
      anti_patterns: {
        repeat_reads: { 'src/auth.ts': 3 },
        read_no_edit: ['README.md'],
        bash_repeats: {},
        edit_retries: {},
        read_per_turn_max: 12,
      },
    },
    ids: [],
  },
};
writeFileSync(join(casesDir, 'task_77777_good.json'), JSON.stringify(failCase, null, 2));

// Synthetic passing case (for regression)
const passCase = {
  ...failCase,
  id: 77778,
  label: 'good',
  task: { ...failCase.task, id: 77778 },
  metrics: { tool_calls: 15, duration_ms: 30000, traceability_score: 0, has_commit: true },
  agents: {
    'developer:1': {
      ...failCase.agents['developer:1'],
      tools: { 'Read': { calls: 5, avg_ms: 90, p90_ms: 120, errors: 0, error_rate: 0 }, 'Edit': { calls: 10, avg_ms: 200, p90_ms: 300, errors: 0, error_rate: 0 } },
      active_duration_ms: 3000,
    },
  },
  tool_metrics: {
    summary: {
      total_calls: 15,
      by_tool: {
        'Read': { count: 5, ok: 5, err: 0, avg_ms: 90, max_ms: 150, p95_ms: 140 },
        'Edit': { count: 10, ok: 10, err: 0, avg_ms: 200, max_ms: 350, p95_ms: 320 },
      },
      duration_total_ms: 2450,
      error_rate: 0,
      anti_patterns: { repeat_reads: {}, read_no_edit: [], bash_repeats: {}, edit_retries: {}, read_per_turn_max: 2 },
    },
    ids: [],
  },
};
writeFileSync(join(casesDir, 'task_77778_good.json'), JSON.stringify(passCase, null, 2));

// ── Test 1: parsePatchMeta ─────────────────────────────────────────────────

console.log('\n[Test 1] parsePatchMeta parses frontmatter correctly');

const samplePatch = `---
target_file: templates/SYNAPSE-worker.md
target_role: developer
failure_metric: tool_calls
---
## Root cause
The developer exceeded tool_calls threshold.

## Proposed rule change
Add: "Before running more than 30 Read calls on the same task, pause and reassess scope."
`;

const { meta, body } = parsePatchMeta(samplePatch);
assert(meta.target_file === 'templates/SYNAPSE-worker.md', `target_file parsed correctly`);
assert(meta.target_role === 'developer', `target_role parsed correctly`);
assert(meta.failure_metric === 'tool_calls', `failure_metric parsed correctly`);
assert(body.includes('Root cause'), `body contains patch content`);

// ── Test 2: parsePatchMeta falls back gracefully ───────────────────────────

console.log('\n[Test 2] parsePatchMeta fallback on missing frontmatter');

const bareBody = '## Root cause\nSomething went wrong.\n';
const { meta: meta2, body: body2 } = parsePatchMeta(bareBody);
assert(meta2.target_file === 'templates/SYNAPSE.md', `falls back to SYNAPSE.md`);
assert(meta2.target_role === null, `target_role null`);
assert(body2.includes('Root cause'), `body preserved`);

// ── Test 3: buildPatchFrontmatter ────────────────────────────────────────────

console.log('\n[Test 3] buildPatchFrontmatter produces valid frontmatter');

const fm = buildPatchFrontmatter({ target_file: 'templates/SYNAPSE-orchestrator.md', target_role: 'orchestrator', failure_metric: 'traceability_score' });
assert(fm.includes('target_file: templates/SYNAPSE-orchestrator.md'), `target_file in frontmatter`);
assert(fm.includes('target_role: orchestrator'), `target_role in frontmatter`);
assert(fm.includes('failure_metric: traceability_score'), `failure_metric in frontmatter`);
assert(fm.startsWith('---\n') && fm.includes('\n---\n'), `frontmatter delimited`);

// ── Test 4: roleToTemplateFile ────────────────────────────────────────────────

console.log('\n[Test 4] roleToTemplateFile maps roles correctly');

assert(roleToTemplateFile('orchestrator') === 'templates/SYNAPSE-orchestrator.md', `orchestrator → orchestrator template`);
assert(roleToTemplateFile('developer') === 'templates/SYNAPSE-worker.md', `developer → worker template`);
assert(roleToTemplateFile('code-reviewer') === 'templates/SYNAPSE-worker.md', `code-reviewer → worker template`);
assert(roleToTemplateFile(null) === 'templates/SYNAPSE.md', `null → shared template`);
assert(roleToTemplateFile('unknown') === 'templates/SYNAPSE.md', `unknown → shared template`);

// ── Test 5: Gate regression check — role-specific patch ──────────────────────

console.log('\n[Test 5] Gate regression: role-specific patch only checks relevant role cases');

// Write a patch targeting developer role
const rolePatch = `---
target_file: templates/SYNAPSE-worker.md
target_role: developer
failure_metric: tool_calls
---
## Root cause
Developer used excessive Read calls.

## Proposed rule change
Add: "If Read calls exceed 20, reassess scope before continuing."
`;
const patchFile = join(patchDir, 'task_77777_patch.md');
writeFileSync(patchFile, rolePatch);

// Manually test the regression filtering logic
const allResults = evaluateCases(casesDir);
const goodResults = allResults.filter(r => r.label === 'good');

// Role-specific: filter to developer role
const devResults = goodResults.filter(r => r.role === 'developer' || r.role === null);
const crossResults = goodResults;  // cross-role = all good cases

assert(goodResults.length >= 1, `at least 1 good case (failCase becomes bad under current thresholds)`);
assert(devResults.length > 0, `developer-role filter returns cases`);
assert(crossResults.length >= devResults.length, `cross-role includes all (≥ role-specific)`);

// ── Test 6: Patch roundtrip ───────────────────────────────────────────────────

console.log('\n[Test 6] Patch frontmatter roundtrip (build → parse)');

const origMeta = { target_file: 'templates/SYNAPSE-worker.md', target_role: 'developer', failure_metric: 'active_duration_ms' };
const built = buildPatchFrontmatter(origMeta) + '## Root cause\nToo slow.\n';
const { meta: parsedBack } = parsePatchMeta(built);
assert(parsedBack.target_file === origMeta.target_file, `target_file roundtrips`);
assert(parsedBack.target_role === origMeta.target_role, `target_role roundtrips`);
assert(parsedBack.failure_metric === origMeta.failure_metric, `failure_metric roundtrips`);

// ── Test 7: Cross-role patch (target_role=null) ───────────────────────────────

console.log('\n[Test 7] Cross-role patch parses target_role=null');

const crossPatch = `---
target_file: templates/SYNAPSE.md
target_role: null
failure_metric: traceability_score
---
## Root cause
Missing result_msg_id.
`;
const { meta: crossMeta } = parsePatchMeta(crossPatch);
assert(crossMeta.target_role === null, `target_role=null for cross-role patch`);
assert(crossMeta.target_file === 'templates/SYNAPSE.md', `target_file is SYNAPSE.md for cross-role`);

// ── Cleanup ───────────────────────────────────────────────────────────────────

rmSync(tmpDir, { recursive: true });

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n=== TEST SUMMARY ===`);
console.log(`PASS: ${passed}  FAIL: ${failed}`);
if (failed > 0) process.exit(1);
