---
name: synapse-planning
description: The manager's planning discipline for a Synapse run — produce a spec, an implementation plan, and a validation plan, get them approved by the operator, and only then delegate to coders. Use when a manager receives a feature or bug-fix root TASK and must plan before implementation, when the operator asks the manager to "plan first" or "show me the plan," or when revising a plan after operator feedback. Not for operating the CLI (see synapse-operator) or for trivial one-line changes that need no plan.
---

# synapse-planning

The manager plans before anyone writes code. For any non-trivial feature or
bug fix, produce three written artifacts, get the operator to approve them,
and only then decompose into `TASK`s for coders. No implementation `TASK`
goes out before the operator has approved the plan.

This skill covers **what to write and the approval loop**. For the exact
`synapse ask` / `--options` / `--ref-id` syntax, see the `synapse-operator`
skill; for your standing responsibilities, see `templates/role-manager.md`.

## When to plan vs. skip

- **Plan** — anything that adds or changes a feature, changes architecture,
  touches more than one file, or carries regression risk. Default to
  planning when unsure.
- **Skip** (go straight to a `TASK`, note "no plan — trivial" in your ack) —
  typos, comment/log wording, a one-line config or copy change with no
  behavioral effect.

## The three artifacts

Write all three before delegating, with `synapse doc` — it puts each file
at its canonical path (you never spell out or guess the run folder), prints
where it landed, and sends no message (you reference the paths from the
approval `QUESTION` and the `TASK`s that follow):

```bash
synapse doc spec     <root-id> spec.md       # what & why
synapse doc plan     <root-id> plan.md       # how, as tasks/subtasks
synapse doc testplan <root-id> testplan.md   # how we prove it
# each lands at .synapse/artifacts/run-<id>/<root-id>-<kind>.md
```

`<root-id>` is the id of the root `TASK` from operator. Keep the three as
separate files so each can be reviewed and revised on its own — re-running the
same `handoff` overwrites in place. Reference the printed path from the
`QUESTION`/`TASK`s that follow.

### 1. Spec — `<root-id>-spec.md`

The architecture design and the feature set to be built. Describe the target
state, not the steps to reach it. Cover:

- **Goal & scope** — one paragraph: what this delivers, and explicitly what
  it does *not* (non-goals prevent scope creep).
- **Feature set** — each user-visible behavior as a short, testable
  statement ("refreshing the page keeps the open file-viewer panel").
- **Architecture** — the components touched or added, how data flows between
  them, key interfaces/contracts, and where state lives. Name the actual
  modules/files in this repo.
- **Constraints & decisions** — dependencies, backward-compat requirements,
  and any design choice with an alternative rejected (one line each). Flag
  open questions here — these become operator `QUESTION`s.

### 2. Implementation plan — `<root-id>-plan.md`

Specific and concise, structured so it maps one-to-one onto `TASK`s a coder
can execute without re-deriving the design. For each task:

- A numbered **task** with an imperative title, broken into **subtasks**
  where useful.
- **Files** it touches (create/edit), and the concrete change in each.
- **Acceptance criteria** the coder self-checks against before reporting done.
- **Dependencies / order** — which tasks must land first; what can run in
  parallel across coders.
- Which **validation-plan** items (by id) this task must make pass.

Keep tasks small enough to review as a single unit. Prefer several sharp
tasks over one vague one. This file is what you paste (or reference) into
each downstream `TASK`.

### 3. Validation plan — `<root-id>-testplan.md`

How the team proves the feature is really built and nothing regressed. Two
layers, both required for a feature:

- **Unit / scenario tests** — concrete cases pinning the new behavior and
  guarding against regression. For each: the case, the input/setup, the
  expected result, and the test file it lives in. These are what the
  `tester` runs after the reviewed merge.
- **End-to-end tests** — runnable in the dev (and, where safe, prod)
  environment, that exercise the feature as the spec describes it end to
  end. Give the exact command/steps and the observable pass condition, so
  "the feature is truly implemented as specified" is checkable, not asserted.

Every feature statement in the spec must trace to at least one validation
item; note the mapping so coverage gaps are visible.

**Reconcile with existing tests — do this, don't assume greenfield.** Before
finalizing, read what's already there (this repo: `tests/*.test.ts`,
`tests/e2e-*.sh`, and any `*-testplan.md` from earlier runs). Then:

- If the change alters behavior an existing test asserts, the plan must say
  which test to **update** and to what — a passing stale test is a false
  negative.
- If existing coverage already exercises part of the feature, **reuse or
  extend** it rather than duplicating.
- Call out any existing test the change is expected to **break** and why
  that break is correct.

List these adjustments explicitly as their own validation items so a coder
picks them up.

## Approval loop

Planning is not done until the operator approves. Iterate:

1. **Write** the three artifacts to the run directory.
2. **Present** — send the operator a `QUESTION` (`synapse ask operator "…"
   --options … --title …`; blocking; `--options` required) that points to the
   three files and asks for a decision.
   Summarize each artifact in a line or two in the body; don't make the
   operator open files to grasp the gist. Options should be real choices,
   e.g. `Approve as-is, Approve with changes, Revise scope`. Then **stop** —
   don't delegate while the question is open.
3. **Discuss & revise** — on feedback, edit the affected artifact(s) in
   place and re-present with another `QUESTION`. Loop until the operator
   picks an approve option. Surface genuine open design questions as their
   own `QUESTION`s rather than guessing.
4. **Record approval** — once approved, note it at the top of the spec
   (`Approved by operator, <date>, ref <msg-id>`) and only then start
   sending implementation `TASK`s, each referencing the plan and its
   validation items.

If the operator later changes the goal mid-run, treat it as a new planning
pass on the affected artifacts — re-approve before new code goes out.

## Guardrails

- No implementation `TASK` before an approve verdict — that's the whole point.
- The plan is the source of truth the coder builds from; if reality diverges
  during implementation, update the artifact and tell the operator, don't
  let the doc rot.
- Keep artifacts concise. A plan a coder won't read is worse than a short one
  they will.

## See also

- `synapse-operator` — the CLI reference for `ask`/`pending`/`QUESTION`
  syntax used throughout the approval loop.
- `templates/role-manager.md` — the manager's full standing role, including
  the test-plan and reporting obligations this skill's planning phase feeds.
