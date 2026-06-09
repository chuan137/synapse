---
name: retro
description: Orchestrator self-retrospective. Invoke after a substantive task closes (≥10 min wall-clock or ≥1 worker delegation) to produce a structured reflection on routing, friction, and what could have been faster. Output to .synapse/retros/<date>-<slot>-retro.md. Orchestrator-only — workers and other roles do not invoke this.
---

# Retro

Orchestrator-only. Produce a structured reflection on routing, decision quality, and hand-off friction while the session context is still warm.

## When to invoke

Invoke `/retro` when ALL of:
- You just transitioned to `idle` after a `finish_task`
- The just-finished task ran ≥10 minutes wall-clock **OR** involved ≥1 worker delegation
- You haven't done a `/retro` since that task started

Skip for trivial back-and-forth (single-message answers, status checks). The trigger is substantive work, not busyness.

## Source material — read before writing

1. `get_history` — last ~30 messages (routing decisions, operator replies, worker reports)
2. The closed task record: `task_id`, `started_at`, `finished_at`, `commit_sha`, `trigger_msg_id`, `result_msg_id`
3. `PLAN.md` current state (`.synapse/PLAN.md`)
4. `git log --oneline -5` — recent commits in context

Don't pad the retro with what you haven't read. If a source is unavailable, say so.

## Required structure of the retro file

Write to `.synapse/retros/<YYYYMMDD-HHMMSS>-<orch_agent_id>.md`:

```markdown
# Retro — <date> — <orch_agent_id>

## Tasks covered
- <task_id>: <title> — <duration> — <commit_sha>

## Routing decisions
For each delegation: did I route to the right worker? Would inline have been faster or cheaper?
Cite message ids. If a worker was a better fit than another, say why.

## Worker hand-off friction
What wasted a round-trip in the spec → execute → review → merge cycle?
Be specific: file paths, message ids, time costs, misread requirements.

## Worker compliance gaps
Did any worker miss part of the spec? Was it a one-off or a pattern?
If a pattern: suggest a concrete protocol or spec adjustment.

## Time-to-decision
Operator asked at T; I delegated/answered at T+N. Was N reasonable for the scope?
Where did time go — reading, confirming, waiting? Name it.

## Negative-space
Decisions where I almost did X but chose Y. The *reason* matters more than the outcome.
(If nothing here after honest reflection, that itself is a finding.)

## Operator friction
Did I clarify the right things? Did I push back when I should have?
Were any options I presented actually distinct, or false choices?

## What I would have done differently
Concrete next-time actions. Not aspirations — specific and replayable.
Example: "write task spec to file before calling delegate_task, not after."

## One-line summary
<single line — used by future summarizer and dashboard>
```

After writing the file, send the one-line summary via:
```
send_message(to_id="human", type="finding", priority=5, content="RETRO <date>: <one-line summary>")
```

## Tone rules — the most important part

Frame every question as **"what could have been faster, clearer, or smaller"** — not "did I do well."

The model's natural bias is to soft-pedal its own mistakes. Counter it:
- Bias toward finding *something* concrete every time.
- A retro that says "no issues" should be presumed lazy, not virtuous.
- Force at least one specific observation even when the task went smoothly — "smooth" usually means "I got lucky on a step that could have gone wrong."

**Forbidden content — omit these entirely:**
- "Task completed successfully" — that's in the tasks table, not here.
- Generic praise/blame ("worker did well", "worker dropped the ball") — not actionable.
- Restating what happened without analysis — that's a diary, not a retro.
- Speculation about future work — that belongs in PLAN.md.
- LLM filler ("valuable lessons", "great collaboration", "I'm proud of") — noise.

**Required specificity:** cite message ids, file paths, commit SHAs whenever you make a claim. Vague observations are noise. "The spec was unclear" is noise; "spec msg 1593 omitted the output path — worker had to infer it, added one round-trip" is a retro entry.

## Output and escalation

**Output location:** `.synapse/retros/<YYYYMMDD-HHMMSS>-<orch_agent_id>.md`
(`.synapse/` is gitignored — retros are not committed.)

**Minimum viable retro:** If genuinely nothing useful after honest reflection, write 2 lines stating that and naming the bar that wasn't cleared. Don't pad to look thorough.

**If the retro reveals a systemic defect:** file a PLAN.md item and reference it from the retro with the PLAN.md line number or section.

**Scope:** Retros are about orchestration quality — routing, specs, delegation, operator interaction. Not about worker implementation quality (that's the code reviewer's job) and not about the product feature itself.
