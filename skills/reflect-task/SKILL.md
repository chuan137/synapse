---
name: reflect-task
description: Per-task execution and routing reflection. Fired automatically by reflect-gate (src/eval/reflect-gate.ts) when a just-finished task shows unusual tool-call volume, repeated read/write churn, or the orchestrator stays idle after the task closed. Produces a structured reflection on what went wrong (or right) during this task. Output to .synapse/reflections/<date>-<slot>-task<id>.md. Orchestrator-only.
---

# Reflect Task

Orchestrator-only. Produce a structured reflection on **one task's execution and routing** — tool-call patterns, file churn, idle drift, routing decisions, root cause. This is not `/retro`.

## How this differs from `/retro`

| | `/retro` | `/reflect-task` |
|---|---|---|
| Trigger | Operator-invoked, or `/api/retros/run` nudge — advisory, can be skipped | `reflect-gate` system message — respond or post a DECISION skip |
| Cadence | Periodic, after a substantive task, covers recent session | Once per task that trips a gate condition |
| Scope | Cross-task routing trends: recurrence of same routing error, systemic patterns | Single task: execution quality (tools, churn, drift) AND single-task routing (reroutes, escalations) |
| Output | `.synapse/retros/` | `.synapse/reflections/` |

## When this fires

Triggered by a `[system] reflect-gate task <N>: <gate> tripped (...)` bus message (see templates/SYNAPSE-orchestrator.md §4). The message names which gate fired:

- **tool_volume** — this task's tool-call count breached the calibrated per-role threshold. The message includes the actual count, threshold, and percent over.
- **file_churn** — the same file was read repeatedly, or an edit/write was retried after a prior error.
- **idle_drift** — neither of the above, but you were still idle a few minutes after the task closed (probabilistic gate — may be a quiet task or a genuine signal).

**Respond to the gate message**: either run this skill or post `DECISION: skip reflect-task <N> — <reason>`. If you skip, the DECISION post preserves the audit trail. See templates/SYNAPSE-orchestrator.md §4 for the full response rule.

## Source material — read before writing

1. The gate-trip message itself — it names the gate and gives the raw numbers (tool_calls vs. threshold, or the churned file paths).
2. The closed task record: `task_id`, `started_at`, `finished_at`, `commit_sha`, `tool_calls`.
3. The case file: `.synapse/evaluations/task_<id>_*.json` — specifically:
   - `metrics`, `agents`, `tool_metrics.summary.anti_patterns` (`repeat_reads`, `edit_retries`, `read_no_edit`, `bash_repeats`, `read_per_turn_max`)
   - `routing_quality` — `reroute_count`, `escalation_count`, `no_decisions_logged`, `time_to_first_done_ms`
4. `get_history` filtered to this task's message range, if you need to see *why* a tool was re-run rather than just *that* it was.

Don't pad the reflection with what you haven't read.

## How to read each gate signal

### tool_volume
- A small overage (+5–15%) for a developer on a large refactor is often fine — note it and move on.
- A large overage (>30%) for a role with a low threshold (orchestrator, planner) usually means scope creep, re-planning, or a miscommunication in the task spec.
- Check `agents` in the case file: which agent drove the volume? A developer reading many files before editing is expected; reading the same files repeatedly (see `repeat_reads`) is not.
- Cross-check with `time_to_first_done_ms`: long time + high tool_calls = probably a hard task; short time + high tool_calls = possibly thrashing.

### file_churn
- `repeat_reads` on a config or schema file is often benign (checked before each edit). Flag it only if the read count is >3× with no edits following.
- `edit_retries` (Edit after a prior error on the same path) are a real signal — usually a worker that didn't read the file before editing or hit a conflict. Name the file and count.
- `read_no_edit` is informational: large lists are normal; a short list of core files that were never edited after reading may indicate a planning gap.

### idle_drift
- The gate fires probabilistically — it is not evidence that something went wrong.
- Check if the task was the last in a sequence and no follow-up existed. If so, "quiet moment, no follow-up task ready" is a complete and correct answer.
- If the orchestrator was idle because it was waiting on a blocked worker or a long-running process, say that.

### routing_quality
- `reroute_count > 0`: the task was handed to more than one worker. Was the first worker the wrong role? Was the spec unclear? Or was the reroute intentional (e.g. reviewer after developer)?
- `escalation_count > 0`: escalations to the human are often correct, but frequent escalations on routine tasks indicate spec gaps.
- `no_decisions_logged`: the orchestrator made routing moves without logging decisions. Not necessarily wrong, but worth noting if combined with a reroute.
- `time_to_first_done_ms`: compare against total task duration. A long wait before the first DONE suggests the first worker stalled or was blocked.

## Required structure of the reflection file

Write to `.synapse/reflections/<YYYYMMDD-HHMMSS>-<orch_agent_id>-task<task_id>.md`:

```markdown
# Reflect — task <task_id> — <date> — <orch_agent_id>
<!-- case-file: .synapse/evaluations/task_<id>_<label>.json -->

## Gate trip
Which gate fired (tool_volume / file_churn / idle_drift) and the raw numbers from the trip message.
If you believe it's a false positive, say so here and why.

## What happened
Concrete account of the execution pattern that tripped the gate. Cite tool names, file paths,
counts, agent_id. Not a narrative — the specific evidence.

## Routing quality
Summarise routing_quality from the case file: reroute_count, escalation_count, no_decisions_logged,
time_to_first_done_ms. Note any anomalies. If all values are baseline (0 reroutes, 0 escalations,
decisions logged, reasonable time to DONE) a single sentence "Routing was clean" suffices.

## Root cause
Classify: worker execution issue / unclear or underspecified task spec / protocol gap / environment
or tooling limitation / genuinely fine (gate was oversensitive). Say which, and why — this drives
whether the fix belongs in a worker prompt, a spec template, SYNAPSE*.md, or nowhere.

## Fix or follow-up
One concrete action: a protocol-patch candidate (file + rule), a `.synapse/progress.md` item, or
"no action — explain why the gate was a false positive here." Not aspirational language.

## One-line summary
<single line — used by future summarizer and dashboard>
```

After writing the reflection file, patch `reflection_path` into the case file:
```
caseData = JSON.parse(readFileSync(caseFilePath, 'utf8'))
caseData.reflection_path = reflectionFilePath
writeFileSync(caseFilePath, JSON.stringify(caseData, null, 2))
```

## Tone rules

Same bar as `/retro`: specificity over narrative, no generic praise/blame, no "task completed successfully" filler. Cite message ids, file paths, and counts. "Lots of reads" is noise; "src/db.ts read 5× across the task, no Edit ever followed — read_no_edit" is a reflection entry.

A reflection that says "everything was fine" for a `tool_volume` or `file_churn` trip should be treated with suspicion — the gate fired on real numbers, so either explain why the numbers were justified (e.g., genuinely large refactor) or name the inefficiency. `idle_drift` trips are the one case where "fine, just a quiet moment" is a legitimate, sufficient answer — say that plainly instead of inventing a problem.

## Output and escalation

**Output location:** `.synapse/reflections/<YYYYMMDD-HHMMSS>-<orch_agent_id>-task<task_id>.md`
(`.synapse/` is gitignored — reflections are not committed.)

After writing the file, send the one-line summary via:
```
send_message(to_id="human", type="finding", priority=5, content="REFLECT-TASK <task_id>: <one-line summary>")
```

**If the reflection reveals a systemic defect** (not a one-off): file a `.synapse/progress.md` item and reference it from the reflection.

**Scope:** Execution quality (tool-call patterns, file churn, idle drift) plus single-task routing quality (reroutes, escalations, decision logging). Not cross-task trends (that's `/retro`'s job) and not a code review of the worker's diff (that's the code-reviewer's job).
