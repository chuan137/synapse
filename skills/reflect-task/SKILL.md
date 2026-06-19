---
name: reflect-task
description: Mandatory per-task execution reflection. Fired automatically by reflect-gate (src/eval/reflect-gate.ts) when a just-finished task shows unusual tool-call volume, repeated read/write churn on the same file, or the orchestrator stays idle a few minutes after the task closed. Produces a structured reflection on what went wrong (or right) during *this task's execution* — not routing. Output to .synapse/reflections/<date>-<slot>-task<id>.md. Orchestrator-only.
---

# Reflect Task

Orchestrator-only. Produce a structured reflection on **one task's execution** — tool-call patterns, file churn, idle drift, root cause. This is not `/retro`.

## How this differs from `/retro`

| | `/retro` | `/reflect-task` |
|---|---|---|
| Trigger | Operator-invoked, or `/api/retros/run` nudge — advisory, can be skipped | `reflect-gate` system message — **mandatory**, see templates/SYNAPSE-orchestrator.md |
| Cadence | Periodic, after a substantive task, covers recent session | Once per task that trips a gate condition |
| Scope | Routing, decision quality, hand-off friction across the session | A single task's execution: did the work itself go sideways |
| Output | `.synapse/retros/` | `.synapse/reflections/` |

If you catch yourself writing about routing decisions, worker selection, or operator interaction here — stop, that belongs in a future `/retro`, not this file. This file is about *what happened while the task ran*: tool usage, churn, drift.

## When this fires

Triggered only by a `[system] mandatory: task <id> tripped reflect-gate (...)` bus message. The message names which gate fired:

- **tool_volume** — this task's tool-call count breached the calibrated per-role threshold.
- **file_churn** — the same file was read repeatedly, or an edit/write was retried after a prior error.
- **idle_drift** — neither of the above, but you were still idle a few minutes after the task closed (a soft signal — something may have been left hanging, or this is simply quiet time; say which after checking).

Do not skip this when the message arrives — it is a protocol-mandatory rule (templates/SYNAPSE-orchestrator.md), not a suggestion. If you genuinely believe the trip was a false positive, say so explicitly in the reflection rather than silently ignoring the message.

## Source material — read before writing

1. The gate-trip message itself — it names the gate and gives the raw numbers (tool_calls vs. threshold, or the churned file paths).
2. The closed task record: `task_id`, `started_at`, `finished_at`, `commit_sha`, `tool_calls`.
3. The case file: `.synapse/evaluations/task_<id>_*.json` — specifically `metrics`, `agents`, and `tool_metrics.summary.anti_patterns` (`repeat_reads`, `edit_retries`, `read_no_edit`, `bash_repeats`, `read_per_turn_max`).
4. `get_history` filtered to this task's message range, if you need to see *why* a tool was re-run rather than just *that* it was.

Don't pad the reflection with what you haven't read.

## Required structure of the reflection file

Write to `.synapse/reflections/<YYYYMMDD-HHMMSS>-<orch_agent_id>-task<task_id>.md`:

```markdown
# Reflect — task <task_id> — <date> — <orch_agent_id>

## Gate trip
Which gate fired (tool_volume / file_churn / idle_drift) and the raw numbers from the trip message.
If you believe it's a false positive, say so here and why.

## What happened
Concrete account of the execution pattern that tripped the gate. Cite tool names, file paths,
counts, agent_id. Not a narrative — the specific evidence.

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

**Scope:** This is about task execution quality only — tool-call patterns, file churn, idle drift, root cause. Not about routing or operator interaction (that's `/retro`'s job) and not a code review of the worker's actual diff (that's the code-reviewer's job).
