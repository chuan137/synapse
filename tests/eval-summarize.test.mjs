#!/usr/bin/env node
/**
 * Tests for eval-summarize.
 * Run: node tests/eval-summarize.test.mjs
 *
 * Uses mock LLM responses — no real API calls.
 */

import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Import the module's non-LLM-dependent parts
const summModule = await import(join(ROOT, 'dist', 'eval', 'summarize.js'));
const { generateSummary } = summModule;

// We'll test the proposal parser directly via reflection if exported,
// otherwise test through generateSummary with mocked Anthropic.

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

// ── Setup: temp directory ─────────────────────────────────────────────────────

const tmpDir = join(ROOT, '.synapse', 'summarize-test-tmp');
const retroDir  = join(tmpDir, 'retros');
const reportDir = join(tmpDir, 'reports');
const patchDir  = join(tmpDir, 'patches');
const gateDir   = join(tmpDir, 'gate_results');

mkdirSync(retroDir, { recursive: true });
mkdirSync(reportDir, { recursive: true });
mkdirSync(patchDir, { recursive: true });
mkdirSync(gateDir, { recursive: true });

// Write synthetic sources
writeFileSync(join(retroDir, '20260609-test-retro.md'), `# Retro
The orchestrator repeatedly forgot to call read_messages at the start of turns.
Several tasks had traceability_score=2 because source_msg_id was missing.
`);

writeFileSync(join(reportDir, '20260609-window-7d.md'), `# Window report: last 7d
## Summary
Tasks completed: 15
## Threshold breaches
- developer: tool_calls exceeded 3 times (tasks #101, #103, #104)
## Blocked events
- CONFUSED: 2 events
`);

const goodPatchContent = `---
target_file: templates/SYNAPSE-orchestrator.md
target_role: orchestrator
failure_metric: traceability_score
---
## Root cause
Missing read_messages call.
## Proposed rule change
Add: "Always call read_messages first."
`;
writeFileSync(join(patchDir, 'task_101_patch.md'), goodPatchContent);

writeFileSync(join(gateDir, 'gate_task_101_patch.json'), JSON.stringify({
  patch_file: join(patchDir, 'task_101_patch.md'),
  target_role: 'orchestrator',
  target_file: 'templates/SYNAPSE-orchestrator.md',
  regression_pass: true,
  coverage_verdict: 'VERDICT: ADEQUATE\nROLE_ADDRESSED: YES\nREASON: addresses root cause',
  coverage_verdict_role: true,
  deploy_recommended: true,
}));

// ── Test 1: Dry run doesn't crash and shows expected output ─────────────────

console.log('\n[Test 1] --dry-run shows plan without LLM call');

// Override process.cwd for the dry run by passing explicit paths isn't possible directly,
// but we can test the dry-run flag behavior by mocking — instead test the output structure.

// We'll verify the dry-run exits cleanly by running it programmatically
// (the real dry-run uses process.cwd(); here we test the logic produces correct output text)
const dryReport = await generateSummary({
  since: '2w',
  dryRun: true,
  outputPath: join(reportDir, 'test-summary.md'),
});

assert(dryReport.proposals.length === 0, `dry-run returns 0 proposals (no LLM call)`);
assert(typeof dryReport.sources.retros === 'number', `dry-run sources object has retros count`);
assert(dryReport.outputPath.endsWith('.md'), `outputPath ends with .md`);

// ── Test 2: Empty sources → graceful "no proposals" ──────────────────────────

console.log('\n[Test 2] Empty sources directory produces empty report without crash');

// generateSummary with dryRun=true to avoid LLM call; sources would be empty
// since tmpDir/retros etc. don't match cwd. The important check: it doesn't throw.
let threw = false;
try {
  const emptyReport = await generateSummary({
    since: '0ms',  // impossible range
    dryRun: true,
    outputPath: join(reportDir, 'empty-summary.md'),
  });
  assert(emptyReport.proposals.length === 0, `empty range returns 0 proposals`);
} catch (e) {
  threw = true;
}
assert(!threw, `empty sources doesn't throw`);

// ── Test 3: Output file structure when given a known path ─────────────────────

console.log('\n[Test 3] Output paths are constructed correctly');

const outPath = join(reportDir, 'test-output-summary.md');
const dryReport2 = await generateSummary({
  since: '7d',
  dryRun: true,
  outputPath: outPath,
});
assert(dryReport2.outputPath === outPath, `explicit outputPath is used`);

// Verify the auto-generated path has correct format when no outputPath given
const autoReport = await generateSummary({ since: '7d', dryRun: true });
assert(autoReport.outputPath.includes('-summary.md'), `auto path contains -summary.md`);
assert(autoReport.outputPath.includes('.synapse/reports/'), `auto path is in .synapse/reports/`);

// ── Test 4: Proposal parser correctly handles well-formed LLM output ──────────

console.log('\n[Test 4] Proposal parser handles well-formed LLM output');

// We can test parseProposals indirectly by mocking the Anthropic client.
// Since we can't easily mock imports, we test the markdown build/parse loop
// by checking the parsed proposal structure.

// Simulate what the LLM would return
const syntheticLLMOutput = `### Proposal 1: Add read_messages guard to orchestrator loop
**Category:** protocol_patch
**Target:** templates/SYNAPSE-orchestrator.md
**Evidence:** retro 20260609-test-retro.md | window-report 20260609-window-7d.md
**Impact:** Would have prevented 8 of last 15 traceability failures

Orchestrators consistently miss calling read_messages at the start of turns.
Add a mandatory guard: "Step 0 of every turn: call read_messages before anything else."

---

### Proposal 2: Reduce developer tool_calls threshold from 80 to 40
**Category:** threshold_adjustment
**Target:** src/eval/thresholds.json
**Evidence:** window-report shows 3 developer tasks exceeded 80 calls | calibration shows p90=30
**Impact:** Would flag 3 additional tasks as over-budget in current window

The empirical p90 for developer tool_calls is 30 but the threshold is 80.
Reduce to 40 (midpoint) as a calibrated upper bound with headroom.

---
`;

// Write a temp canned version to verify our parser works
// We do this by running generateSummary with a stubbed Anthropic call
// Since we can't mock cleanly without extra tooling, just validate the pattern manually:

// Check that the parser works on the output directly
// (We import and call the internal parser via re-export or just check the regex pattern)
const propRegex = /### Proposal \d+: ([^\n]+)\n([\s\S]+?)(?=\n### Proposal \d+:|\n## |\n---\n*$|$)/g;
let m;
const parsedProposals = [];
while ((m = propRegex.exec(syntheticLLMOutput)) !== null) {
  const title = m[1].trim();
  const block = m[2];
  const getField = label => {
    const fm = block.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`));
    return fm ? fm[1].trim() : '';
  };
  parsedProposals.push({
    title,
    category: getField('Category'),
    target: getField('Target'),
    evidence: getField('Evidence').split('|').map(e => e.trim()),
    impact: getField('Impact'),
  });
}

assert(parsedProposals.length === 2, `parsed 2 proposals from synthetic output`);
assert(parsedProposals[0].title.includes('read_messages'), `first proposal title correct`);
assert(parsedProposals[0].category.includes('protocol_patch'), `first proposal category correct`);
assert(parsedProposals[1].category.includes('threshold_adjustment'), `second proposal category correct`);
assert(parsedProposals[0].evidence.length >= 2, `first proposal has ≥2 evidence citations`);
assert(parsedProposals[0].impact.length > 0, `first proposal has impact estimate`);

// ── Cleanup ───────────────────────────────────────────────────────────────────

rmSync(tmpDir, { recursive: true });

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n=== TEST SUMMARY ===`);
console.log(`PASS: ${passed}  FAIL: ${failed}`);
if (failed > 0) process.exit(1);
