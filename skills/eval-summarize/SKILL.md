---
name: eval-summarize
description: Ingests retros, window reports, and critic patches to produce concrete improvement proposals (protocol patches, new skills, threshold adjustments, role tweaks). Invoke when the operator wants a structured retrospective across multiple tasks/windows, or when deciding what protocol changes to propose next.
---

# Eval summarize

Closes the retro-eval loop. Reads three sources of self-knowledge — quantitative metrics (eval pipeline), per-window aggregates (window reports), and qualitative orchestrator retros — then calls an LLM to identify concrete improvement proposals.

## When to invoke

Invoke `/eval-summarize` when:
- Operator asks "what should we improve?", "what patterns do you see?", "what would help most?"
- After accumulating 1-2 weeks of tasks or after a threshold-breach streak
- Before proposing a protocol change — ground it in data first
- Operator-triggered only. Do NOT auto-fire on a schedule without explicit consent.

Do NOT invoke just to fill space. If there's insufficient data (fewer than ~5 tasks with metrics), the report will say so and that's fine.

## What the skill does

### Step 1 — Run the CLI

```bash
synapse eval-summarize --since 2w [--dry-run] [--output <path>]
```

- `--since 2w`: how far back to gather sources (retros, window reports, patches)
- `--dry-run`: check source counts and prompt size without invoking the LLM

This reads:
- `.synapse/retros/*.md` — orchestrator self-retros
- `.synapse/reports/*-window-*.md` — window-report outputs
- `tests/gate_results/gate_task_*_patch.json` — gate verdicts with `deploy_recommended: true`
- `tests/patches/task_*_patch.md` — recent critic patches

### Step 2 — Read the report

The CLI writes two files:
- `.synapse/reports/<timestamp>-summary.md` — human-readable markdown with numbered proposals
- `.synapse/reports/<timestamp>-summary.json` — machine-readable `SummaryReport` struct

Read the markdown report. Each proposal has:
- **Category**: `protocol_patch | new_skill | threshold_adjustment | role_tweak`
- **Target**: which file or skill the change addresses
- **Evidence**: 2+ citations from source documents
- **Impact**: rough estimate (e.g., "would have prevented 3 of last 10 failures")

### Step 3 — Verify and forward

For each proposal:
1. Check the cited evidence is real (open the cited retro/report and verify)
2. Confirm the impact estimate is plausible, not inflated
3. Confirm the proposal is concrete — it names a specific file, rule, threshold, or skill

Then send one-line summary to operator via `send_message` (`type: finding`, priority 5).

## How to interpret proposals

| Category | What it means | Who acts |
|---|---|---|
| `protocol_patch` | A specific line to add/change in a SYNAPSE*.md | Operator reviews, applies via `synapse eval-apply` |
| `new_skill` | A new slash-command skill needed | Operator decides to build it |
| `threshold_adjustment` | Calibration drift detected — thresholds need recalibration | Run `synapse eval --calibrate` after curator's approval |
| `role_tweak` | Worker role rules need adjustment | Operator reviews, adjusts role templates |

**NOTHING auto-merges.** Proposals are suggestions. Only apply after operator approval.

## Tone rules

- Forward concrete proposals only — "add line X to file Y" beats "improve traceability"
- If proposals cite vague evidence or make inflated claims, flag it: "Proposal N cites retro X but the retro doesn't actually show that pattern"
- If the LLM returns 0 proposals or only weak ones, say so: "Insufficient data for concrete proposals."
- Forbidden: "great progress", "the team is performing well", any LLM padding

## Output

1. Run `synapse eval-summarize --since <range>`
2. Read `.synapse/reports/<timestamp>-summary.md`
3. Verify each proposal's evidence
4. `send_message` to human: `type: "finding"`, priority 5 — one sentence naming the highest-leverage proposal or confirming no actionable findings.

## Example invocation

```
/eval-summarize --since 7d
```
