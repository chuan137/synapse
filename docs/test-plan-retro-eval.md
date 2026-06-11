# Test Plan: Retro-Eval Loop

## 1. Summary

The retro-eval loop is a self-improvement pipeline for Synapse swarms. It turns task execution data into actionable proposals by flowing through five stages: extraction (raw trajectories) → evaluation (per-task pass/fail) → windowed aggregation → critic+gate (patch proposals with regression gating) → long-term summarization (cross-retro proposals). A `/retro` skill lets the orchestrator produce structured qualitative reflection; an `/eval-window-report` skill distills window aggregates for human consumption; a `/eval-summarize` skill (task 124, in flight) synthesizes both streams.

**Not in scope for this test plan:** UI extensions (S-Deck charts), automated cadence (cron triggers), threshold recalibration pending fresh corpus data. Those are operator-gated.

---

## 2. Architecture Diagram

```
tasks + tool_metrics (DB)
         │
         ▼
  [extract.ts / synapse eval]
  TrajectoryV2 cases → .synapse/cases/<task_id>_{good,bad}.json   ← raw corpus
  Curated subset      → tests/cases/<task_id>_{good,bad}.json     ← selected via eval-select
         │
         ├──▶ [evaluator.ts / synapse eval]
         │    per-task pass/fail + metrics vs thresholds.json
         │    → eval_results DB table (role, agent_id, metrics, pass)
         │
         ├──▶ [window.ts / synapse eval-window]
         │    aggregates over time window → .synapse/reports/*-window-*.md
         │    consumed by /eval-window-report skill (orchestrator)
         │
         ├──▶ [critic.ts + patch.ts]
         │    failing case → Claude-generated patch → tests/patches/task_<id>_patch.md
         │    patch has frontmatter: target_file, target_role, failure_metric
         │
         ├──▶ [gate.ts]
         │    patch → re-runs eval on cases scoped to target_role → deploy_recommended
         │    → tests/gate_results/gate_task_<id>_patch.json
         │
         ├──▶ [/retro skill]  (orchestrator only, post-task)
         │    qualitative reflection → .synapse/retros/<timestamp>-<agent_id>.md
         │
         └──▶ [summarize.ts / synapse eval summarize]  (task 124, in flight)
              ingests: retros + window reports + gate verdicts + patches
              → proposals (protocol_patch | new_skill | threshold_adjustment | role_tweak)
              → .synapse/reports/<timestamp>-summary.md
              consumed by /eval-summarize skill (orchestrator)
```

---

## 3. Per-Feature Test Matrix

### 3.1 Eval v2 — trajectory schema + calibration + regression  
**Commit:** `6888b92` | **File:** `tests/eval-v2.test.mjs` (42 assertions across 3 test sections)

**Unit tests today:**

| Test section | What it covers |
|---|---|
| [Test 1] Extractor v2 output shape | `schema_version`, `agents` map, `AgentTrajectory` fields, `blocked_events`, `raw` compat fields |
| [Test 2] Calibrate: thresholds.json | `calibrated_at`, `by_role`, `sample_size`; roles with <3 samples are skipped |
| [Test 3] Evaluator regression | All `tests/cases/*_good.json` pass; all `*_bad.json` fail |

**Integration gaps:** No test exercises the DB migration (`eval_results` gains `role` + `agent_id` columns). Migration correctness is asserted by running the app against a real DB — not covered in the test file.

**End-to-end check:**
1. `cd` to repo root
2. Run: `node tests/eval-v2.test.mjs`
3. Expected: 42 assertions pass, exit 0
4. Verifies: v2 schema shape, calibration guard, regression baseline

---

### 3.2 Task ID attribution — direct FK on tool_metrics  
**Commit:** `12f3c41` | **File:** `tests/tool-metrics-taskid.test.mjs` (13 assertions across 5 test sections)

**Unit tests today:**

| Test section | What it covers |
|---|---|
| [Test 1] setCurrentTaskId writes correctly | Cookie written to in-memory store |
| [Test 2] tool:after ingest | Worker row gets `task_id`; orchestrator row gets NULL |
| [Test 3] clearCurrentTaskId | Cookie cleared after clear call |
| [Test 4] tool:after with no cookie | `task_id` NULL when no cookie set |
| [Test 5] clearCurrentTaskIdForTask | Clears all agents holding a given task |

**Integration gaps:** Tests use a mock DB and mock hook dispatch. The actual server hook wiring (`delegate_task` sets cookie → `report_done` clears it) is not exercised in isolation. The invariant is tested implicitly by the eval regression suite running against real recorded cases.

**End-to-end check:**
1. Run: `node tests/tool-metrics-taskid.test.mjs`
2. Expected: 13 assertions pass, exit 0
3. Verifies: FK attribution plumbing, cookie lifecycle

---

### 3.3 Extractor FK-first + idle_drift signal + wall_clock_ms_p90  
**Commit:** `5f0aad6` | **File:** `tests/extract-fk-wallclock.test.mjs` (15 assertions across 4 test sections)

**Unit tests today:**

| Test section | What it covers |
|---|---|
| [Test 1] Extractor FK-first | v2 cases use `agents` map derived from FK-attributed rows |
| [Test 2] idle_drift fires on high ratio | `wall_clock_ms / active_duration_ms > 10` sets `idle_drift` in `blocked_events` |
| [Test 3] idle_drift does NOT fire at ≤10 | Guard against false positives |
| [Test 4] Evaluator regression | Good/bad baseline unchanged after extractor change |

**Known signal noise (covered in §6):** `idle_drift` fires on 109/120 cases in the current corpus because legacy data has `active_duration_ms ≈ 0`. The test in section 2 exercises the logic correctly; the corpus noise is a data quality issue.

**End-to-end check:**
1. Run: `node tests/extract-fk-wallclock.test.mjs`
2. Expected: 15 assertions pass, exit 0
3. Verifies: FK preference over time-window fallback, drift signal correctness

---

### 3.4 eval-window CLI + per-window aggregation  
**Commit:** `21f01f8` | **File:** `tests/eval-window.test.mjs` (21 assertions across 5 test sections)

**Unit tests today:**

| Test section | What it covers |
|---|---|
| [Test 1] Duration parser | `7d`, `2w`, `1h` parse correctly; invalid input throws |
| [Test 2] Aggregation correctness | Correct pass rate, role breakdown, top tool computed over synthetic fixture |
| [Test 3] Empty window | Returns "no-activity" report string, not an error |
| [Test 4] Role filter | `--role developer` returns only developer rows |
| [Test 5] Idle drift flag | High-ratio tasks surface in `idle_drift_count` |

**Integration gap:** `synapse eval-window` CLI subprocess invocation is not tested; the test imports `aggregateWindow()` directly. A CLI flag mismatch would not be caught.

**End-to-end check:**
1. Run: `node tests/eval-window.test.mjs`
2. Run: `synapse eval-window --since 7d` (exits 0; output to stdout or default report path)
3. Expected: report contains role breakdown table and at least one numeric row
4. Verifies: aggregation pipeline and CLI plumbing

---

### 3.5 Case-file split: raw vs curated + eval-select CLI  
**Commit:** `9a6a244` | **File:** `tests/eval-select.test.mjs` (15 assertions across 5 test sections)

**Unit tests today:**

| Test section | What it covers |
|---|---|
| [Test 1] eval-select copies file | Raw → curated copy preserves content |
| [Test 2] select --remove | Removes from curated, raw intact |
| [Test 3] --list on empty curated | Graceful, no error |
| [Test 4] calibrate reads raw by default | `--calibrate` sources `.synapse/cases/`, not `tests/cases/` |
| [Test 5] calibrate --from-curated on empty | Warning logged, not crash |

**Integration gap:** Tests use temp dirs, not the live `.synapse/cases/` corpus. Cases that exist in the corpus but were written before the split convention could have an inconsistent label pattern — not validated.

**End-to-end check:**
1. Run: `node tests/eval-select.test.mjs`
2. Run: `synapse eval-select --list` (exits 0; lists curated cases or "empty")
3. Verifies: file-split invariant and CLI graceful handling

---

### 3.6 Critic + Gate v2 — patch frontmatter + role-scoped regression  
**Commit:** `bb94ef3` | **File:** `tests/critic-gate-v2.test.mjs` (25 assertions across 7 test sections)

**Unit tests today:**

| Test section | What it covers |
|---|---|
| [Test 1] parsePatchMeta parses frontmatter | `target_file`, `target_role`, `failure_metric` parsed from YAML front block |
| [Test 2] parsePatchMeta fallback | Missing frontmatter → default values, no crash |
| [Test 3] buildPatchFrontmatter | Serializes valid YAML front block |
| [Test 4] roleToTemplateFile | Role string → correct template path |
| [Test 5] Gate regression: role-specific patch | Gate only evaluates cases matching `target_role` |
| [Test 6] Frontmatter roundtrip | build → parse round-trips correctly |
| [Test 7] Cross-role patch | `target_role=null` → evaluates all roles |

**Integration gap:** Critic invocation against real Claude API is not tested (requires `ANTHROPIC_API_KEY`). Tests stub the LLM call. Real patch quality is assessed via the manual smoke test in §5.

**End-to-end check:**
1. Run: `node tests/critic-gate-v2.test.mjs`
2. Expected: 25 assertions pass, exit 0
3. Verifies: frontmatter parsing/serialization, role-scoped gate logic

---

### 3.7 /retro skill  
**Commit:** `849e315` | **File:** `skills/retro/SKILL.md`

No automated tests. Correctness is prompt-engineering — assessed via manual smoke test (§5.1). Key properties to check: trigger criteria are clear, forbidden content rules are present, output path convention is specified, one-line summary is sent to human.

---

### 3.8 tool-lookup skill (deferred)  
**Commit:** `3dc2ebb` | **File:** `skills/tool-lookup/SKILL.md`

Deferred — not protocol-wired. Light smoke test only (§5.2).

---

### 3.9 LLM summarizer (task 124 — in flight on :37)  
**Future file:** `src/eval/summarize.ts` | **Future test:** `tests/eval-summarize.test.mjs`

**Planned unit coverage (stubs for when 124 lands):**

| Test section | What to cover |
|---|---|
| Source discovery | Correct files found in `.synapse/retros/`, reports, patches, gate results within `--since` window |
| Proposal parsing | `Proposal` shape: `category`, `title`, optional `target_file`, `confidence`, `rationale` |
| Empty sources | Returns `proposals: []`, `sources` counts all zero, exits 0 |
| Model call | Stubbed — assert prompt contains retro text and window-report excerpts |
| Output file | Written to `.synapse/reports/<timestamp>-summary.md` |

**End-to-end check (post-124):**
1. Ensure at least 1 retro in `.synapse/retros/` and 1 window report in `.synapse/reports/`
2. Run: `synapse eval summarize --since 2w`
3. Expected: output file created, `proposals` array non-empty, each proposal has `category` and `title`
4. Requires: `ANTHROPIC_API_KEY` set

---

## 4. Cross-Cutting Tests

These scenarios are not yet automated. Each is a candidate for a future integration test.

**Schema migration idempotency**
- Scenario: Run DB migration from scratch; run again on already-migrated DB.
- Steps: `rm -f .synapse/synapse.db && synapse eval --limit 1 && synapse eval --limit 1`
- Expected: No SQL errors, no duplicate column errors. `eval_results` has `role` and `agent_id` columns.
- Gap: Not currently in any test file.

**v1 → v2 backwards compatibility**
- Scenario: Synthesize a v1-shaped case (no `agents` map, only `raw` fields); run it through critic and gate.
- Expected: Critic generates a patch; gate processes without crash; coverage verdict notes "no per-role data."
- Gap: No v1 fixture in `tests/cases/`. The `raw` compat fields exist in v2 schema, but no test exercises the critic/gate path on a v1-shaped input.

**FK + time-window cohabitation**
- Scenario: Task with some tool_metrics rows where `task_id IS NULL` (pre-migration) and some where `task_id` is set (post-migration).
- Steps: Insert synthetic mixed rows into a temp DB; run extractor.
- Expected: Both NULL-`task_id` rows (time-window fallback) and FK rows are included in the trajectory; no rows dropped silently.
- Gap: Not in any current test.

**Cookie correctness across sequential delegations**
- Scenario: Orchestrator delegates task A to worker; worker DONEs. Orchestrator delegates task B to same worker. Tool calls during B must attribute to B, not A.
- Expected: `tool_metrics.task_id` for B's calls is B's task_id; A's cookies are cleared on `report_done`.
- Partial coverage: `tests/tool-metrics-taskid.test.mjs` [Test 5] covers `clearCurrentTaskIdForTask`; the sequential delegation scenario itself is not exercised.

---

## 5. Manual Smoke Tests for Skills

Skills are prompt-driven; their correctness can't be fully auto-tested. Run these before any skill file change.

### 5.1 /retro

**Operator:** Invoke `/retro` in an orchestrator session after a substantive task closes (≥10 min or ≥1 worker delegation).

**Expected output:**
- File created at `.synapse/retros/<YYYYMMDD-HHMMSS>-<orch_agent_id>.md`
- File contains all required sections: Tasks covered, Routing decisions, Worker hand-off friction, Worker compliance gaps, Time-to-decision, Negative-space, Operator friction, What I would have done differently, One-line summary
- `send_message(to_id="human", type="finding")` with the one-line summary is sent

**Red-flag outputs:**
- "Task completed successfully" as a finding (that's for the tasks table)
- Generic praise/blame without message ids or file paths
- "No issues" with no supporting negative-space entry
- LLM filler phrases ("valuable lessons", "great collaboration")
- Section missing `##` header (breaks future summarizer parsing)

### 5.2 /eval-window-report

**Operator:** Invoke `/eval-window-report` with a window report file path present in `.synapse/reports/`.

**Expected output:** Structured report with role breakdown, top failing agents, idle drift count, actionable observations. One-line summary sent to human.

**Red-flag outputs:** Empty sections, "no data" with no explanation, missing role breakdown.

### 5.3 /eval-summarize (post-task 124)

**Operator:** Invoke `/eval-summarize` after at least 1 retro and 1 window report exist.

**Expected output:**
- Proposal list with `category`, `title`, and `rationale` for each item
- Sources section showing counts of retros/reports/gate verdicts ingested
- Each proposal cites the source (retro filename or window report path)

**Red-flag outputs:** Proposals with no rationale, categories outside the four defined types, no source citations, fabricated file paths.

---

## 6. Known Coverage Gaps

| Gap | Detail | Path to closure |
|---|---|---|
| Thin calibration roles | Only `developer` and `orchestrator` have ≥3 sample buckets. `code-reviewer` and `doc-writer` thresholds fall to defaults. | Run more tasks with those roles to populate `.synapse/cases/`; re-calibrate. |
| `idle_drift` false positives | Fires on ~109/120 corpus cases because legacy rows have `active_duration_ms ≈ 0`. The signal is correct logic-wise; the corpus is stale. | Refresh corpus from fresh task data; the ratio will normalize. |
| DB migration not in tests | `eval_results` schema change (`role`, `agent_id` columns) has no automated migration test. | Add a migration test that drops and rebuilds the DB, checks column existence. |
| v1 case compat not tested | No v1-shaped fixture in `tests/cases/`; critic/gate path on v1 input is untested. | Synthesize one v1 fixture and add a critic/gate test against it. |
| LLM summarizer (task 124) | `src/eval/summarize.ts` not yet merged; `tests/eval-summarize.test.mjs` not yet written. | Covered by stubs in §3.9; re-assess when :37 reports DONE. |
| CLI subprocess tests missing | `eval-window` and `eval-select` tests import module functions directly; CLI flag mismatches won't be caught. | Add one subprocess-level test per CLI command using `node --test` or child_process. |

---

## 7. Regression Suite — Must-Pass Baseline

Run these before any merge to main that touches `src/eval/`, `src/server/`, or `skills/`:

```sh
node tests/eval-v2.test.mjs                  # 42 assertions
node tests/tool-metrics-taskid.test.mjs      # 13 assertions
node tests/extract-fk-wallclock.test.mjs     # 15 assertions
node tests/eval-window.test.mjs              # 21 assertions
node tests/eval-select.test.mjs              # 15 assertions
node tests/critic-gate-v2.test.mjs           # 25 assertions
# After task 124 lands:
node tests/eval-summarize.test.mjs           # TBD

# CLI smoke (no DB write; read-only):
synapse eval --limit 3 --calibrate           # exits 0
synapse eval-window --since 7d               # exits 0
synapse eval-select --list                   # exits 0
```

**Total baseline (current):** 131 assertions across 6 files.

---

## 8. CI Hook Recommendation

The regression suite in §7 should run in CI on every PR touching `src/eval/`, `src/server/`, or `skills/`. The six pure-logic test files (`eval-v2`, `tool-metrics-taskid`, `extract-fk-wallclock`, `eval-window`, `eval-select`, `critic-gate-v2`) are self-contained and have no external dependencies — they should always run.

The LLM-invoking paths (critic, gate coverage verdict, summarizer) require `ANTHROPIC_API_KEY`. These should be skipped gracefully when the key is absent (`process.env.ANTHROPIC_API_KEY` check at test entry). A recommended pattern: set `SKIP_LLM_TESTS=1` in the CI environment for fast runs; the key-gated workflow runs nightly with the real key set.

Skill files (`skills/*/SKILL.md`) have no automated CI — they rely on the manual smoke tests in §5. A lint step checking that frontmatter fields `name` and `description` are present in every `SKILL.md` would catch accidental breakage cheaply.
