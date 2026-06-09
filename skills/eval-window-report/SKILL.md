---
name: eval-window-report
description: Aggregate eval metrics across a time window (default 7d) and produce a narrative interpretation. Invoke when the operator asks "how have we been doing this week / today / last N days", or when the orchestrator wants to ground a decision in recent metrics before proposing a protocol change.
---

# Eval window report

Produces a structured markdown report from the eval database, then adds a narrative interpretation layer.

## When to invoke

Invoke `/eval-window-report` when:
- The operator asks "how have we been doing", "what happened this week", "any patterns in the last N days"
- You (orchestrator) want to ground a protocol-change proposal in actual task metrics
- After a notable incident (stuck worker, unexpected failure streak) to understand the scope
- Periodic retrospective (operator-triggered — do not auto-run on a cron without operator consent)

Do NOT invoke just to fill space. If the operator asks a specific question that doesn't require metrics, answer directly.

## What this skill does

### Step 1 — Run the CLI

```bash
synapse eval-window --since <range> [--role <role>]
```

Default range: `7d`. Adjust based on what the operator asked. The CLI writes a structured report to `.synapse/reports/<timestamp>-window-<range>.md` and prints it to stdout.

### Step 2 — Read the report

Read the generated file. The report has these sections:
- **Summary**: task counts, commits, wall-clock time, per-role breakdown
- **Per-role aggregates**: median/p90 tool_calls, wall_clock, error rate, commit %
- **Tool usage**: top 10 tools by volume
- **Threshold breaches**: roles hitting their calibrated limits
- **Blocked events**: CONFUSED/ERROR/WAITING counts with quotes
- **Idle drift**: tasks where wall-clock >> active tool time (stuck-worker pattern)
- **Recurring patterns**: repeated titles, Bash error spikes

### Step 3 — Write a narrative interpretation

Produce a short (≤200 word) narrative covering what's actually interesting. Focus on anomalies, not summaries.

## How to read the output

Translate raw numbers into observations:

| Signal | What it means |
|---|---|
| Role consistently breaching `tool_calls_p90` | Workers doing more than usual — calibration drift or task scope creep |
| `idle_drift` count rising | Workers blocked waiting for operator or stuck on a slow external call |
| High CONFUSED blocked events | Spec quality issue — workers receiving underspecified tasks |
| Low `has_commit %` for developer role | Delegation without follow-through — investigate if tasks closed without code |
| `unknown` role appearing in aggregates | Agents without a role set in `agent_status` — run `synapse eval --calibrate` to check |
| Tool error rate > 10% | Systemic issue with a specific tool (permission, environment) |

Cite specific task IDs when calling out anomalies (`#123`, `#124`).

## Tone rules

- Bias toward concrete observations: "developer role hit p90 tool_calls on 3 of the last 5 tasks" beats "tool usage was elevated"
- Do NOT write: "everything looks good", "great progress", "the team is performing well"
- If nothing notable: 2 sentences naming what was checked and that nothing flagged. Do not pad.
- Quote from the report directly (e.g., the CONFUSED blocked event text) when relevant

## Output

1. Run the CLI: `synapse eval-window --since <range>`
2. Read `.synapse/reports/<timestamp>-window-<range>.md`
3. Write narrative interpretation to `.synapse/reports/<timestamp>-window-narrative.md`
4. `send_message` to human with `type: "finding"`, priority 5: one sentence naming the most notable finding or confirming nothing flagged.

## Example invocation

```
/eval-window-report --since 24h
```

Produces both the structured CLI report and a narrative. If operator asked "how are things going today", this gives the grounded answer.
