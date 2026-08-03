# Synapse — proposed improvements

Against `synapse-spec.md` rev 3. Six issues, one section each: what the spec says
today, what to change, and what it costs. Not a rev — a menu.

Issues 1–4 are mechanical guarantees currently left to a model or left undetected.
Issue 5 is latency. Issue 6 is the principle the other five follow from, and is
the only one that is purely editorial.

---

## 1. Dispatch belongs to the watcher, not the manager

**Current.** §4.1 and §4.3: the manager, during its turn, finds ready rows and
spawns them. Every dispatch therefore costs a manager turn, and a compacted
manager that fails to re-read the tables can silently fail to dispatch a ready
row.

**Proposed.** The watcher dispatches. On each poll, after the cascade and sweep,
it spawns every ready row (`stage='unassigned'` and all deps `done`), subject to
the concurrency cap. The manager's job narrows to two things a model is actually
required for: **creating rows** and **writing verdicts**.

**Why.** Readiness is a SQL query and spawning is a subprocess call — neither
requires judgment. Three consequences:

- Fewer manager turns, so slower transcript growth and lower per-turn cost
  (§4.9's budget).
- Dispatch stops being something the manager can forget after a compaction.
- The manager's remaining work is exactly the irreducible part, which makes
  Phase 5's quality question cleaner to evaluate.

**Cost.** The manager loses the ability to *decline* to dispatch a row it has
already created. If that is ever wanted, the mechanism is to not create the row
until it is wanted — which the on-the-fly creation path already supports.

**Test.** Create a ready row while no manager turn is pending; assert it is
spawned by the watcher with zero manager wakes.

---

## 2. Retry is unbounded

**Current.** A failed row is an ordinary transition (§4.5). The manager judges it
and typically creates a replacement. Nothing counts attempts and nothing stops
the loop: fail → replace → fail → replace, indefinitely, burning tokens with no
error surfaced.

**Proposed.** Two columns on `subtasks`:

- `supersedes` INTEGER — the row this one replaces, NULL if original.
- `attempt` INTEGER — 1 for an original; `supersedes.attempt + 1` otherwise,
  computed by the controller, not supplied by the manager.

The controller enforces a cap (default 3). At the cap, `synapse task
--supersedes <id>` is **rejected**. The manager must then either escalate with a
QUESTION or leave the row failed.

**Why.** Whether to retry is judgment. *How many times anyone may retry* is not —
it is a resource bound, and resource bounds enforced by a model are not bounds.

**Cost.** Two columns, one rejection path. The chain also gives the operator a
readable history of what was tried, which the current design loses entirely.

**Test.** Force three consecutive failures on the same unit of work; assert the
fourth `--supersedes` is rejected and the manager's response is a QUESTION rather
than another row.

---

## 3. A dependency cycle deadlocks silently

**Current.** Nothing validates `depends_on`. A manager that writes `A depends_on
B` and `B depends_on A` produces two rows that are never ready, so nothing spawns,
so no rev is ever assigned, so the watcher never wakes anything, so `synapse done`
blocks forever. **No error is raised anywhere.**

**Proposed.** `synapse task --depends-on` rejects an edge that would close a
cycle. Check at write time, inside the same transaction as the insert.

**Why.** A workflow engine validates its graph before running it, because a human
authored the graph and it is fixed. Synapse cannot — the graph is authored
incrementally by a model at runtime. Validation therefore moves from design time
to **write time**. This is the structural cost of dynamic orchestration and rev 3
does not pay it.

**Cost.** One reachability query per row creation. Graphs are small.

**Test.** Attempt to create the closing edge of a cycle; assert rejection with
the offending path named.

---

## 4. No stall detector

**Current.** The general form of issue 3, of which the cycle is one instance:
nothing is running, nothing is ready, and rows remain non-terminal. Every other
failure mode in the design produces a rev; this one produces silence, which is
indistinguishable from "idle and healthy."

**Proposed.** The watcher checks each poll:

```
no row is `assigned`
AND no row is ready
AND some row is non-terminal
AND no QUESTION is awaiting an answer
```

All four true for two consecutive polls → write a NOTE to the operator naming the
stuck rows, and mark the run `stalled` (a run status, not a subtask stage).

**Why.** That conjunction is structurally impossible in a healthy run. Excluding
the pending-QUESTION case matters: waiting on the operator looks identical and is
correct.

**Cost.** One query per poll, one run status value.

**Test.** Hand-build a cycle directly in the database (bypassing issue 3's
rejection), assert the stall NOTE appears within two polls.

---

## 5. The completion pattern is unstated, and the poll is the latency floor

**Current.** Rev 3 describes the mechanism — rev, high-water-mark, 2s poll — but
never names the pattern. There is no push path, so worker completion to manager
reaction is up to 2s. The operator UI's latency is not specified at all: §4.4's
2s is the watcher's, and principle 4 says the operator sees results "immediately"
without saying how.

**Proposed.** Three parts.

*State the pattern* in §1:

> A worker's completion is delivered as a **durable write plus a poller**, never
> as a callback. No component's completion depends on any other component being
> alive at that moment.

*Add a hint, not a signal.* After `synapse reply` commits, read
`.synapse/watcher.pid` and `SIGUSR1` it; the watcher's sleep is interruptible and
it polls immediately. Governed by one rule: **every push path must be droppable
with no correctness loss.** Lost signal, dead watcher, stale pidfile → the next
tick catches it.

*Pin the UI.* State the operator view's own interval explicitly and note it is
independent of the watcher's — the operator's read is not gated on the manager
either way, which is the part of principle 4 that actually holds.

**Why.** The durable-write property is what makes the watcher-restart test pass
and is the single most likely thing for a future contributor to optimize away.
Naming it protects it. The hint buys latency without touching it.

**Cost.** A pidfile and a signal handler.

**Test.** Run the entire Phase 3 suite with the hint disabled; everything passes,
only slower. If any test ever *requires* the hint, the hint has become the signal
of record and the property is gone.

---

## 6. The organising principle is missing

**Current.** Rev 3 splits mechanical work from judgment correctly in most places
— readiness, cascade, termination gating — but never states the rule, so each new
decision re-litigates it. Issues 1–4 are all the same drift: a mechanical
guarantee left to a model, or left to nothing.

**Proposed.** Add to §1:

> **The manager decides only what cannot be computed.** Anything mechanically
> derivable is computed by the controller, not delegated to a model — otherwise
> every mechanical guarantee becomes probabilistic.

And a table in §3 fixing where each job sits:

| Job | Owner | Kind |
|---|---|---|
| Scheduling (what is runnable) | `depends_on` + readiness query | mechanical |
| Dispatch (spawn it) | watcher (issue 1) | mechanical |
| State transfer | worktree inheritance | mechanical |
| Graph validity | write-time check (issue 3) | mechanical |
| Retry bound | controller cap (issue 2) | mechanical |
| Termination | `task_progress` + `synapse done` | mechanical |
| Decomposition | manager | **judgment** |
| Evaluation | manager verdict | **judgment** |
| Escalation at the cap | manager QUESTION | **judgment** |

**Why.** This is the actual difference from a conventional orchestrator. That
architecture has no box for judgment because a human authored the graph at design
time; Synapse moved that one job to a model at runtime. Everything else should
stay mechanical, and the table makes drift visible.

**Cost.** Editorial.

---

## Ordering

**Assumes Phase 4 complete** (schema, wrapper, watcher, real worker prompts, Stop
hook) and Phase 5 not started.

The controlling fact: issues 1–4 all concern a *model* authoring the dependency
graph or deciding to retry. `policy-manager.ts` is deterministic, so none of them
can bite today. They all switch on when `manager.md` exists — which makes the
window for taking them exactly now, before the manager prompt is written.

| Issue | When | Why now |
|---|---|---|
| 6 — principle | before 1 | Editorial; makes the dispatch move read as a consequence rather than a preference |
| 1 — dispatch → watcher | before `manager.md` | The prompt encodes what the manager believes its job is. `policy-manager.ts` shrinks — it is test code and cheap to change. After Phase 5 this means rewriting a tuned prompt |
| 3 — cycle rejection | before `manager.md` | Write-time check in `subtasks.ts`. Cycle risk begins the moment a model authors edges |
| 2 — retry columns + cap | before `manager.md` | Schema recreate; §7 already declares no migration. Cap enforced at creation now; escalation tested in Phase 5 |
| 4 — stall detector | before `manager.md` | Poll loop already exists. Catches the Phase 5 failures that cannot be predicted individually |
| 5 — hint | anytime, or never | The only issue with no correctness stake. The pattern statement is free; the signal is pure latency work |

**Regression to watch.** Issue 1 is the first change that can quietly break the
zero-model-call milestone. After moving dispatch, re-run the full Phase 3 fake
suite and confirm it still passes with no model calls — that milestone is what
keeps judgment failures and plumbing failures distinguishable for the rest of the
build.
