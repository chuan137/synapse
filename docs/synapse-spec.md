# Synapse — Design Specification

> A multi-agent coordination system: several Claude Code sessions work as a
> team on one or more goals, coordinating through a shared SQLite database.

Status: DRAFT rev 6 — pending operator approval.
Implementation decisions in §9.

---

## Changelog

Newest first. Delta only — rationale lives in the section that changed.

**rev 6** — The manager stops being a series of `claude -p --resume` processes
and becomes a **persistent tmux session**: one long-lived interactive Claude
Code process in a named pane that never exits between turns (§4.9, D8). The
watcher wakes it by sending the wake prompt into the pane rather than spawning
a fresh process, which removes the per-turn transcript cold-start reload — the
manager's accumulated context now lives in a resident process, not reloaded
from disk each wake. Turn completion is no longer a process exit; the manager
signals it with a new terminal verb, **`synapse turn-done`** (§5), which the
watcher observes as a DB write — completion becomes a table fact like
everything else (principle 1), and mutual exclusion stays structural because
the watcher waits on that write, not on a process signal. `manager_turns`
keeps its job of distinguishing the first wake (create the session, no pane
yet) from later wakes (send into the existing pane). Compaction risk is
unchanged — Claude Code compacts the same in-process context — so §4.9's
standing instruction stays load-bearing. New benefit: the operator can attach
to the pane and watch the manager reason live, which matters most at the
Phase 7 trial gate. Cost, recorded in §4.9: turn-completion detection now
rests on the manager reliably calling `turn-done`; a manager that finishes
without it leaves the watcher waiting, so the wake carries a timeout backstop.

**rev 5** — Dispatch moved from the manager to the watcher, settling §8's open
question and clearing §3.1's recorded deviation. The watcher's poll is now an
ordered four-step cycle — sweep, cascade, dispatch, wake. The manager's job
narrows to the two things a model is required for: creating rows and writing
verdicts. An open QUESTION explicitly does **not** pause dispatch: it blocks the
manager's decision, not the run, leaving row existence as the single lever on
dispatch. Plan approval is unaffected and in fact strengthened, since it rests on
rows not existing rather than on a pause rule holding.

Also in rev 5: the **monotonic `rev` counter and the `manager_reacted_rev`
high-water-mark are removed**, replaced by a per-row `delivered` flag on
`subtasks` and `messages`. `delivered` is written **only by the watcher**, once,
after a turn that carried the row completes — the manager has no bookkeeping verb
at all, and `verdict` is its sole row write. This removes the single row every
writer contended on, and makes mid-turn loss and same-second collisions
impossible rather than hazards to order around. The wake scans for undelivered
work: operator messages first, then the lowest-`id` task, batching that task's
undelivered rows into one turn.

Two costs, both deliberate. No total order across tables. And delivery is not
judgment: a manager that judges three of five still has all five delivered. The
alternative — re-offering until the manager clears each row — hands a model the
ability to re-summon itself indefinitely, so the skipped rows are surfaced by an
advisory NOTE (`delivered=1`, terminal, `verdict IS NULL`) instead. `verdict`
consequently drives nothing and stays purely semantic.

Deliver-once also removed the last reason to keep **`tasks.status` as a
declaration**. A forgotten "set status=done" used to be recoverable by the next
wake; under deliver-once nothing would ever re-offer the batch, so the run would
block on `synapse done` in silence. Completion is therefore computed:
`work_closed` = every subtask terminal **and delivered**, which waits for the
manager to have seen the batch in a completed turn without racing its judgment.
Creating no further row is the acceptance. `tasks.status` now holds only `open`
and the operator's `cancelled`, and the manager has no completion verb.

Dispatch is **non-blocking**: `spawn` claims synchronously (spawn, then one
transaction writing stage/session/pid) and supervises without the poll loop
awaiting it, so a worker's minutes do not stall the watcher. The manager turn
stays awaited, keeping mutual exclusion structural rather than flag-based. The
cost is recorded in §4.5: a watcher that dies with workers in flight loses their
exit detail to the layer-3 sweep.

Debt whose outcome is mechanically determined — all three cancellation sources —
is **settled by the controller at write time** and never reaches the manager's
queue (§4.2, §4.6). `failed` is explicitly excluded: the write is mechanical, the
response to it is not.

Serialization, previously an accident of dispatch happening inside a
single-threaded manager turn, is now explicit and split in two: keeping two
writers off one tree is a **graph** property (`depends_on` gains a third job,
§2.3.1) and `--max-workers` is demoted to a pure resource knob that cannot break
correctness at any value. Dispatch asserts on worktree collision rather than
locking, so a missing ordering edge produces a signal instead of two workers
overwriting each other. Ties break by `id`. Two new open questions: whether the
watcher awaits each worker (a §4.5 layer-2 mechanism question, not an ownership
one), and the cascade's over-reach on ordering-only edges (§4.6).

**rev 4** — Editorial. Added principle 7 (the manager decides only what cannot be
computed) and §3.1, the table fixing which jobs are mechanical and which are
judgment. Dispatch recorded there as a known deviation, pending §8's decision.

**rev 3** — *Correction:* the manager is a persistent **session**, not a process;
every wake rehydrates the transcript, which makes the stateless-turn contract the
mechanism rather than a safety net and makes manager verbosity a per-turn cost.
Retired "board" as a term. Collapsed `board`/`status` into one read verb. Approval
became a QUESTION with no stored state. Cancellation kills the process group.
`BEGIN IMMEDIATE` required on every writing transaction. Split `start` into
`init` + `watch --run R`, making watcher restart an ordinary command. Added
`manager_turns` for the first-wake `--session-id` path. Added §9.

**rev 2** — Subtasks made strictly 1:1 with workers: review and test became
sibling rows joined by `depends_on`, replacing the per-row gate columns. Added a
`failed` stage with a three-layer guarantee that a worker's exit always writes.
Replaced the timestamp high-water-mark with a monotonic `rev`, fixing mid-turn
loss and same-second collisions. Made the watcher the sole spawner of manager
turns. One verb per message type. Added `worktree_path`. Demoted `tasks.status`
to a declaration with terminality derived. Promoted the SQLite pragmas into the
spec.

**rev 1** — Initial draft. Blackboard over four tables; no agents or roles table;
manager persistent, workers one-shot; watcher waking on a timestamp
high-water-mark.

---

## 1. Overview

Synapse runs a team of AI agents against an operator's goals. One **manager**
agent decomposes each goal into units of work; the controller dispatches those
units to short-lived **worker** agents (coders, reviewers, testers, and other
roles) as their dependencies clear. All
coordination happens through a shared SQLite database — there is no direct
agent-to-agent messaging bus and no central broker.

The design is a **blackboard architecture**: shared state is the coordination
medium and the single source of truth. Workers write their results to the
`subtasks` table and exit. The manager reacts to those writes — and to new goals
from the operator — and decides what happens next. A human operator reads the
tables directly and converses with the manager.

("Blackboard" is used once, here, as pattern attribution. Everywhere else the
tables are named.)

Work is a three-level hierarchy:

```
run    (the team / session — holds the one persistent manager)
 └── task     (a goal from the operator — "build X", later "add Y")
      └── subtask  (a unit of worker work under that goal)
```

Every *process* in the system is exactly one of two things: **the run** (the one
persistent manager) or **a subtask** (a one-shot worker). There is no third kind
of agent and no separate registry of agents — see §2.

A subtask is **1:1 with a worker**. Reviewing a change and testing a change are
their own subtask rows, siblings under the same task, linked to the row they
act on by `depends_on` (§2.3). One row, one worker, one result, one verdict.

### Design principles

1. **The tables are the truth.** Progress lives in the database. Every consumer
   — operator, manager, watcher — reads it; no state of record lives in an
   agent's private context or in a message log.
2. **Workers are disposable.** A worker is a process that runs one subtask and
   exits. A worker *is* its subtask row. Liveness is not tracked as state — but
   every worker's exit is *guaranteed to produce a subtask transition*, success or
   failure (§4.5). The absence of a write is never a valid outcome.
3. **The manager is the only persistent mind.** It accumulates judgment across
   the whole run. Everything it decides is written to a row, so its context is a
   cache that can be lost (to compaction) without losing the run — see §4.9, where
   this is a hard contract, not a hope. The manager *is* the run row.
4. **The human sees everything, immediately.** The operator reads the tables
   with no relay through the manager, so status is never gated on the manager's
   attention.
5. **Goals accumulate.** A run is a standing team; the operator sends goals over
   time. Each goal is a task; the manager plans the work under it.
6. **Small surface.** Four tables, roughly a dozen commands, one background
   watcher.
7. **The manager decides only what cannot be computed.** Anything mechanically
   derivable is computed by the controller, not delegated to a model — otherwise
   every mechanical guarantee becomes probabilistic. §3.1 fixes where each job
   sits.

---

## 2. Data model

Four tables. There is no `agents` table (a worker is a subtask row; the manager
is the run row) and no `roles` table (roles are built into the controller, §3).

### 2.1 `runs` — the team / session (holds the persistent manager)

| Column | Type | Meaning |
|---|---|---|
| `id` | INTEGER PK | run id |
| `status` | TEXT | `running` \| `done` \| `failed` |
| `manager_session_id` | TEXT | the manager's tmux session/pane name (the watcher wakes it by sending into the pane, §4.9); the run row *is* the manager's record |
| `manager_model` | TEXT | the manager's Claude model |
| `manager_turns` | INTEGER | turns run, incremented after each; `0` means the session does not exist yet (§4.4) |
| `created_at` | TEXT | ISO timestamp |
| `ended_at` | TEXT | ISO timestamp, NULL until closed; the manager's "completed_at" is the run's |

The run holds **no goal text** — goals live in `tasks`. The run is a standing
team, not a single goal. The manager is 1:1 with the run (one persistent tmux
session spanning all its tasks), so it needs no row of its own.

### 2.2 `tasks` — a goal from the operator

The operator's goals. The initial goal at `synapse start` is the first task
row; each follow-up goal adds another. A task is created by an operator
`REQUEST` message (§2.4).

| Column | Type | Meaning |
|---|---|---|
| `id` | INTEGER PK | task id |
| `run_id` | INTEGER FK | the team this goal belongs to |
| `text` | TEXT | the goal as the operator stated it |
| `status` | TEXT | `open` \| `cancelled` only. Completion is **not** stored — it is derived (below) |
| `source_message_id` | INTEGER FK | the operator `REQUEST` message that stated this goal |
| `created_at` | TEXT | ISO timestamp |
| `done_at` | TEXT | ISO timestamp, NULL until terminal |

**A task's completion is computed, never declared.** The manager has no verb that
marks a task done; `status` carries only `open` and the operator's `cancelled`.
Everything else is a view over the subtask rows:

```sql
CREATE VIEW task_progress AS
SELECT t.id, t.run_id, t.status,
       COUNT(s.id)                                          AS n_subtasks,
       SUM(s.stage IN ('done','failed','cancelled'))        AS n_terminal,
       COUNT(s.id) > 0
         AND COUNT(s.id) = SUM(s.stage IN ('done','failed','cancelled'))
                                                            AS work_settled,
       COUNT(s.id) > 0
         AND COUNT(s.id) = SUM(s.stage IN ('done','failed','cancelled'))
         AND COUNT(s.id) = SUM(s.delivered = 1)
                                                            AS work_closed
FROM tasks t LEFT JOIN subtasks s ON s.task_id = t.id
GROUP BY t.id;
```

`work_settled` is false for a task with **zero** subtasks — a goal that has been
stated but not yet planned is not finished.

`work_closed` adds the condition that every one of those terminal rows has been
**delivered** (§4.2). That second clause is what makes the computation safe to
substitute for a judgment. `work_settled` alone becomes true the instant the last
row finishes — before the manager has seen any of it — so closing on it would
race ahead of the evaluation §3.1 assigns to the manager. `work_closed` waits
until the manager has been shown the whole batch in a turn that completed. If it
then created no further rows, that *is* its ruling, expressed through the lever
it already has (§4.3: to run something, create a row). A task is terminal when
`work_closed` is true, or when `status='cancelled'`.

This removes a stored declaration that carried no information and could be
forgotten. Under rev 5's deliver-once rule a forgotten declaration would have
been unrecoverable — the batch is never re-offered, so nothing would ever wake
the manager to try again, and the run would block on `synapse done` in silence.
Computing it makes that failure impossible rather than detectable.

### 2.3 `subtasks` — one row per unit of work (and per worker)

The heart of the system. The manager creates rows under a task; exactly one
worker is spawned per row, does that row's work, and exits. A worker's process
facts live on its row — the worker *is* the row.

| Column | Type | Meaning |
|---|---|---|
| `id` | INTEGER PK | subtask id; also identifies its worker ("subtask-7's worker") |
| `run_id` | INTEGER FK | |
| `task_id` | INTEGER FK | which goal this work serves |
| `title` | TEXT | what this unit of work is |
| `assignee_role` | TEXT | which role does it (`coder`, `reviewer`, …) |
| `depends_on` | TEXT | JSON array of subtask ids that must be `done` first; `[]` if none. **The first element is this row's subject** (§2.3.1) |
| `worker_session_id` | TEXT | the worker's Claude session UUID, assigned by the controller at spawn; **not unique across rows** |
| `worker_model` | TEXT | the worker's Claude model |
| `worker_pid` | INTEGER | the worker process, NULL until spawned; used for liveness sweep and cancellation kill |
| `worktree_path` | TEXT | the filesystem the worker acts in (§4.7) |
| `stage` | TEXT | `unassigned` → `assigned` → `done`; or `failed`, `cancelled` |
| `result_summary` | TEXT | what the worker did (written on its reply), or the failure detail if `failed` |
| `artifact_path` | TEXT | pointer to a handoff doc, NULL if none |
| `verdict` | TEXT | the manager's ruling on this row (`LGTM`, `issues: …`), NULL until judged |
| `cancel_reason` | TEXT | why it was cancelled, NULL otherwise |
| `cancelled_at` | TEXT | ISO, set if the row is cancelled |
| `delivered` | INTEGER | 0/1. Written **only by the watcher**, after a turn that carried this row completes (§4.2) |
| `created_at` | TEXT | ISO timestamp |
| `updated_at` | TEXT | ISO, for humans only — **not** used for control |

Terminal stages: `done`, `failed`, `cancelled`.

#### 2.3.1 `depends_on` does three jobs

It is the **dispatch gate** ("do not spawn until these are `done`"), the
**subject pointer** ("this is the row I am reviewing"), and — because
`worktree_path` is derived from it (§4.7) — the **mutual-exclusion edge** that
keeps two writers off one tree.

A reviewer row for subtask 7 has `depends_on = [7]`; a tester row that needs both
the code and a fixture has `[7, 9]` and its subject is 7. The controller passes
the subject row's `artifact_path` and `worktree_path` into the worker's prompt.

**The first element is the subject; every other element is a gate.** A row that
must wait on 8 and 9 but reviews 7 is `[7, 8, 9]`, never `[8, 7, 9]`. The
position is load-bearing, so the ordering edges added for job three always go
after the subject, never in front of it.

The gate replaces rev 1's `needs_review` / `needs_test` columns: "review is
required" is now expressed by a reviewer row existing.

**On job three.** Rows that share a `worktree_path` must not run at once if any
of them writes. Rather than a runtime lock over trees, this is expressed in the
graph: the row that would collide declares an edge to whatever is still running
in that tree. Two reasons. A lock is a second scheduler whose decisions do not
appear in the tables, which costs principle 1 — the operator would see two rows
ready and one of them silently not running. And the case that actually collides
is narrow: only `coder` writes (§3), so a reviewer and a tester sharing a tree
are both readers and do not conflict; two coders share a tree only when one
inherits from the other, which means an edge already exists. The one real gap is
a fix-round coder `[8]` starting while tester 9 is still reading tree 7 — and
`[7, 8, 9]` is the edge that case wanted on its own merits anyway, since a fix
should wait for every judgment on the row it replaces, not just the review.

Because a missing edge of this kind is silent, dispatch asserts against it rather
than trusting it (§4.4).

#### 2.3.2 Other modeling choices

- **Two creation paths, one table.** A subtask row is created either **up-front**
  (approving a plan materializes the whole plan's rows at once, stage=unassigned,
  with their dependency edges, so the operator sees the full arc) **or on the
  fly** (the manager creates a row during execution — a follow-up goal's work, a
  re-do after a bad review, an emergent unit). The row is the truth regardless
  of *when* it was born.
- **The manager owns no row.** Its work is *judging* subtask rows; its ruling is
  the `verdict` field on the row it judged, not a message. A freshly-compacted
  manager reads the row and sees its own verdict.
- **A worker owns no separate record.** Its identity is its subtask id; its
  process facts (`worker_session_id`, `worker_model`, `worker_pid`,
  `worktree_path`) are columns on the row.
- **`worker_session_id` is a process artifact, not an identity.** Do not index or
  join on it. It is normally fresh per row, but a fix-round row may deliberately
  resume the original coder's session (§4.8), so the same UUID can appear twice.
- **`stage` is authoritative** — no per-stage timestamps; the "when" of each
  stage is observability we don't need for control.
- **Workers are blinkered by design.** A worker sees only its own row (and its
  subject's artifact); the whole run is the manager's and operator's view,
  obtained by query, never a stored summary blob.

### 2.4 `messages` — the operator conversation

Agent *work* flows through `subtasks`, not through messages. The `messages`
table carries the operator↔manager conversation only.

| Column | Type | Meaning |
|---|---|---|
| `id` | INTEGER PK | |
| `run_id` | INTEGER FK | |
| `author` | TEXT | `operator` or `manager` |
| `type` | TEXT | `REQUEST` \| `QUESTION` \| `ANSWER` \| `NOTE` |
| `ref_id` | INTEGER | the message this answers (NULL for a root) |
| `body` | TEXT | |
| `title` | TEXT | short header for a QUESTION card |
| `options` | TEXT | JSON array of choices (required on a QUESTION) |
| `delivered` | INTEGER | 0/1, meaningful iff `author='operator'`; written only by the watcher (§4.2) |
| `created_at` | TEXT | ISO timestamp |

`to_agent` is dropped: only two identities exist, so the recipient is whoever
the author is not. `author` is kept (rather than deriving direction from `type`)
because `NOTE` is legal in both directions.

Message types — each is a distinct CLI verb, so the type is never inferred from
the text:

| verb | type | author | behavior |
|---|---|---|---|
| `synapse request "<goal>"` | REQUEST | operator | **creates a `tasks` row** |
| `synapse ask "<q>" --options a,b,c` | QUESTION | manager | blocks the manager's next decision, **not** the run's dispatch (§4.4); UI renders a card; `options` required |
| `synapse answer <id> "<text>"` | ANSWER | operator | resolves by `ref_id`; unblocks the manager |
| `synapse say "<text>"` | NOTE | either | none — plain chat |

Three of the four are behavior-bearing; `NOTE` is not, and is not pretended to
be. Rev 1's lifecycle tags (`[start]`/`[done]`/`[blocked]`) are removed: that is
status, status lives in `subtasks`, and the operator reads it directly
(principle 4).

The load-bearing distinction is **REQUEST vs NOTE** — "build the auth module"
creates a task, "use tabs not spaces" does not. Putting that on the operator's
choice of verb makes it unambiguous and needs no classifier.

Illegal combinations (`QUESTION` from the operator, `REQUEST` from the manager,
`QUESTION` without `options`, `ANSWER` with no `ref_id`) are rejected by the
command layer.

---

## 3. Roles

Roles are **built into the controller** as hard-coded prompt templates — no
roles table, no external config. The shipped set:

- **`manager`** — plans each goal, creates the rows that carry it, judges
  results, converses with the operator. It does not dispatch (§4.3).
  Persistent (one per run; it is the run row).
- **`coder`** — implements a change. One-shot.
- **`reviewer`** — judges its subject row's change against acceptance criteria.
  One-shot.
- **`tester`** — runs the validation plan for its subject row. One-shot.
- **`doc-writer`** — produces documentation/specs. One-shot.

`synapse spawn <role>` launches a worker with its built-in prompt and a default
model. `--model` and `--prompt-file` are optional overrides — `--prompt-file` is
the escape hatch to try a variant prompt without editing the controller. Adding
a *permanent* new role is a controller code change.

Roles carry no gate configuration; gating is `depends_on` (§2.3.1).

### 3.1 What the manager does, and what it does not

Principle 7 applied. This table is the boundary between the controller and the
model, and exists so that drift across it is visible rather than gradual.

| Job | Owner | Kind |
|---|---|---|
| Scheduling — what is runnable | `depends_on` + the readiness query (§4.3) | mechanical |
| Dispatch — spawning a ready row | watcher (§4.3, §4.4) | mechanical |
| State transfer between rows | worktree inheritance (§4.7) | mechanical |
| Worker exit capture | hook / wrapper / sweep (§4.5) | mechanical |
| Dependency cascade | watcher (§4.6) | mechanical |
| Termination gating | `work_closed` + `synapse done` (§2.2) | mechanical |
| Wake ordering | outstanding-debt scan, `tasks.id` order (§4.2) | mechanical |
| Decomposition — what work exists | manager | **judgment** |
| Evaluation — was the work good | manager verdict | **judgment** |
| Escalation when stuck | manager QUESTION | **judgment** |

**Dispatch was the last deviation, and rev 5 closed it.** Readiness is a SQL
query and spawning is a subprocess call; neither requires judgment. Through rev 4
it sat with the manager, which put dispatch on the critical path of a model turn
and made it a thing a compacted manager could fail to do. It is now the
watcher's (§4.3). What the manager gave up in exchange is recorded there.

With that move the table has no mixed rows left: every mechanical job is owned by
the controller, and the manager's three remaining jobs are exactly the ones with
no computable form.

The conventional-orchestrator contrast is the point of the table: that
architecture has no row for judgment, because a human authors the graph at design
time and the engine only executes it. Synapse moved exactly one job — authoring
the graph — to a model at runtime. Everything else should stay mechanical.

---

## 4. How it works

### 4.1 The lifecycle of a run

```
operator: synapse start --goal "build X"      (= init, then watch)
  synapse init:
    → create runs row (status=running, manager_turns=0)
    → generate manager_session_id (names the tmux pane; no pane exists yet)
    → create the first REQUEST message + its tasks row, print the run id
  synapse watch --run <id>:
    → start the watcher
    → (start does NOT wake the manager directly — the watcher does, §4.4)

manager (persistent tmux session = the run row), woken by the watcher:
  → FIRST ACT, ALWAYS: synapse status --run <id> --json  (§4.9)
  → new REQUEST? → plan: write spec / plan / testplan docs; ask operator to approve
  → on approval: materialize the plan's subtask rows up front
    (stage=unassigned, with depends_on edges — coder, then its reviewer,
     then its tester, as sibling rows)
  → may also create rows ON THE FLY during execution
  → it does NOT spawn anything; creating a ready row is how work starts (§4.3)
  → LAST ACT: synapse turn-done — the process stays resident in its pane,
    the watcher stops waiting and proceeds (§4.9)

worker (one-shot = a subtask row):
  → claude -p --session-id <uuid>: read its row + its subject's artifact, work
  → synapse reply <subtask-id> "<result>" [--handoff <kind>:<file>]
      (writes result_summary + artifact_path, stage=done, delivered=0)
  → process exits
  → if it exits WITHOUT replying, the wrapper writes stage=failed (§4.5)

watcher (background, polling — four steps, in this order, §4.4):
  → 1. SWEEP:    any `assigned` row whose worker_pid is gone → failed (§4.5)
  → 2. CASCADE:  any row whose deps are terminal-but-not-done → cancelled (§4.6)
  → 3. DISPATCH: every READY row (stage=unassigned, all deps done), up to the
                 concurrency cap → spawn a one-shot worker (§4.3)
  → 4. WAKE:     scan for outstanding debt (§4.2). Operator messages first;
                 otherwise the lowest-id task with undelivered rows. Send one
                 wake into the manager's pane, scoped to that batch; block on
                 the `synapse turn-done` write (with a timeout backstop, §4.9)

manager (woken):
  → judge each row in its batch (write `verdict`), decide next
      (create follow-up/re-do rows; the watcher runs whatever becomes ready)
  → creating no further rows IS the acceptance: once the batch is delivered and
    nothing new exists, task_progress.work_closed becomes true (§2.2)
  → all tasks terminal → synapse done (the watcher's gate, §4.6)

operator (throughout):
  → reads the tables directly (live view) — each result the moment it is written,
    no manager relay
  → sends follow-up goals (synapse request); answers questions (synapse answer)
```

### 4.2 Delivery

Two kinds of write are things the manager needs to see: a subtask reaching a
terminal stage, and an operator-authored message. Each is marked **on the row
itself**, as `delivered = 0`:

- a worker's `synapse reply` (stage → done)
- a wrapper/sweep failure write (stage → failed)
- a cancel-cascade (stage → cancelled)
- any **operator**-authored message (REQUEST, ANSWER, NOTE)

Everything the manager itself does is undelivered by nobody — verdicts, row
creation, its own QUESTIONs and NOTEs create no delivery obligation, or it would
wake itself in a loop.
Dispatch (`stage → assigned`) creates none either, for a different reason: it is
the watcher's write, and a row *starting* is not something the manager owes a
reaction to.

**Delivery is the watcher's bookkeeping, and the manager cannot touch it.** The
watcher selects a batch, runs one turn carrying it, and — **only if that turn
completes** — writes `delivered=1` across the batch. A turn that dies mid-way
leaves the batch undelivered and it is carried again, the same way a failed turn
leaves `manager_turns` alone (§4.4).

This is principle 7 taken to its end: a bookkeeping flag a model maintains is a
flag that drifts, so the model maintains none. There is no `ack` verb. The
manager's only write about a row is `synapse verdict`, which is its actual work
product rather than an accounting artifact.

#### What that trades away, and why it is acceptable

Delivery is not judgment. A manager handed five rows that judges three still has
all five marked delivered — the other two are not re-offered. That is the same
shape as rev 2's high-water-mark, at row granularity, and it is a real loss.

It is accepted because the alternative is worse in a way that is harder to see:
making re-delivery depend on the manager clearing rows means the manager can
re-summon itself indefinitely by clearing nothing, burning a turn and a full
transcript reload every poll, with no error surfaced. A bound on that loop is
possible but is a rule about a model's behaviour; delivery-once is a property of
the controller.

The skipped rows are not lost silently, because there is a second, weaker signal
already available:

> **Health check.** A row that is `delivered=1`, terminal, and still has
> `verdict IS NULL` after some time is *probably* one the manager skimmed past.
> The watcher writes a NOTE naming such rows.

`verdict IS NULL` is too weak to drive control flow — not every terminal row
deserves a ruling, so it would fire on legitimate cases — but it is exactly
strong enough for an advisory NOTE. Different jobs, different evidentiary bars.
`verdict` therefore stays purely semantic: NULL means *no ruling*, and never
carries any scheduling meaning.

#### Writes that are born delivered

Where an outcome is mechanically determined, there is nothing for the manager to
see, and the write that produces it sets `delivered=1` itself:

| Write | `delivered` at creation | Why |
|---|---|---|
| Cascade cancel (dep failed, §4.6 source 3) | **1** | The reason is derived, and already recorded in `cancel_reason` |
| Operator cancels a task (§4.6 source 1) | **1** | The operator's decision, not the manager's |
| Manager cancels a row (§4.6 source 2) | **1** | The manager wrote it; it does not owe itself a reaction |
| Worker `reply` → `done` | 0 | Evaluation is judgment |
| Wrapper/sweep → `failed` | 0 | Whether to redo is judgment |
| Operator REQUEST / ANSWER / NOTE | 0 | Conversation is judgment |

The line is §3.1's line applied to delivery: mechanical outcomes are settled
mechanically. It matters most for the cascade, which can cancel a dozen rows at
once — a batch that would otherwise dominate a turn while telling the manager
nothing it could not derive.

**`failed` is never born delivered**, despite looking equally mechanical. The
write is mechanical; the response to it is not. Marking it delivered at creation
would let failures pass the manager entirely — a worse outcome than any this
section prevents.

#### Why this replaces rev 2's monotonic counter

Revs 2–5 carried a per-run counter (`rev_counter`) and a single high-water-mark
(`manager_reacted_rev`). Both are gone. The counter's job was to order writes so
the watcher could tell what was new; per-row debt answers that question directly,
and answers a harder one the mark could not:

- **The mark was per-run, so partial reactions were lossy.** A manager that woke,
  judged three of five terminal rows, and ended its turn advanced the mark past
  all five, and every later row too. Per-row delivery narrows the loss to rows the
  manager was actually shown, and the health NOTE surfaces those; the mark lost
  rows it had never offered at all.
- **Mid-turn loss stops being a thing to prevent.** Rev 2 avoided it by reading
  the mark before the turn and writing it after — correct, but a rule that had to
  hold. A row that lands mid-turn was not in the batch, so it is still
  `delivered=0` and the next scan picks it up. The ordering discipline, and its
  regression test, are no longer needed.
- **The counter was the one row every writer contended on.** Every terminal write
  bumped `runs.rev_counter`, serialising all writers in a run against a single
  row. Writers now touch only their own row. (`BEGIN IMMEDIATE` is unaffected and
  still required — `replySubtask` reads the stage before writing it, §4.10.)

What is given up is a **total order across tables**. There is no longer a single
sequence answering "did that ANSWER arrive before or after subtask 7 finished."
Nothing in the controller needs it; §4.9's telemetry and a future UI timeline
would, and would have to reconstruct it (`created_at` is ISO seconds and is not
control data).

#### Scan order

Debt is scanned, not queued — a queue built at scan time goes stale while the
manager works. Each wake picks a batch fresh:

1. **Operator messages first**, as a single batch, run-scoped. `messages` has no
   `task_id`, and an ANSWER is what unblocks approval (§4.11), so operator
   traffic is answered ahead of work rather than waiting behind it.
2. Otherwise the **lowest-`id` task** with undelivered rows, and *all* of that
   task's undelivered rows in one turn.

`tasks.id` rather than `created_at`: ids are assigned in creation order, so the
sequence is identical, and an integer key cannot tie the way ISO-second
timestamps can. Batching within a task means one turn judges one goal's results
together, which is the unit judgment actually wants; splitting across tasks keeps
each turn to one goal. Starvation is not a Tier 1 concern at `--max-workers 1`
— one worker cannot outproduce the manager, and finishing goal 1 before goal 2 is
the wanted behaviour — but it becomes one when the cap is raised, since `id`
order then compounds across dispatch and task selection.

**There is no wake loop to bound.** Because delivery is the watcher's own write
and happens once, a manager that does nothing with a batch is not re-offered it,
so it cannot re-summon itself. The unbounded-retry failure mode that a
manager-cleared flag would create does not exist here, and no stall bound is
needed to contain it. What remains is the health NOTE above, which is advisory.

`updated_at` remains on `subtasks` for humans reading the table. It is not used
for control.

### 4.3 Readiness and dispatch

A row is **ready** when `stage='unassigned'` and every id in `depends_on` has
`stage='done'`. Because the edges are stored, readiness is a single SQL query —
a fact about the tables, never about anyone's context.

**The watcher dispatches.** On every poll it spawns each ready row, up to the
concurrency cap (§4.4). The manager neither computes readiness nor spawns
anything: principle 7, since neither step needs judgment. Creating a row *is*
how the manager starts work — a row that exists and becomes ready will run.

Three consequences, and the third is the reason:

- Dispatch leaves the critical path of a model turn. A row whose deps clear
  starts in the next poll rather than waiting for the manager to be woken, judge,
  and get around to it.
- Dispatch survives a failed manager turn. The turn that would have judged the
  predecessor can throw, and the successor still runs.
- **Dispatch cannot be forgotten after a compaction**, because the compacted
  thing was never the thing dispatching (§4.9).

What the manager gives up is the ability to **decline** to run a row it has
already created. Where that is wanted, the mechanism is to not create the row
until it is wanted — the on-the-fly creation path (§2.3.2) already supports
exactly this, and it is cheaper than a dispatch veto because the row's absence is
visible in the tables while a withheld dispatch would not be.

### 4.4 The trigger model

One persistent background component — the **watcher** — owns everything
mechanical. Each poll runs four steps, in this order:

1. **Sweep** — any `assigned` row whose `worker_pid` is gone → `failed` (§4.5).
2. **Cascade** — any row whose deps are terminal-but-not-done → `cancelled`
   (§4.6).
3. **Dispatch** — spawn every ready row (§4.3), up to the concurrency cap.
4. **Wake** — if any debt is outstanding, run exactly one manager turn, scoped
   to one batch (§4.2).

Two of the three adjacencies do work; the third is arbitrary and is written down
as arbitrary so nobody later invents a reason for it.

- **Sweep before cascade** so a worker that died this poll has its dependents
  cancelled in the same poll. The gain is not latency on those rows — they were
  never ready, so nothing was going to spawn them — but **batching**: the
  `failed` row is undelivered before step 4 (the `cancelled` rows are born
  delivered, §4.2), so a single turn carries the whole consequence of that death
  rather than the manager waking twice into a changing picture.
- **Cascade before dispatch is arbitrary.** The two act on disjoint sets: a row
  is ready only when every dep is `done`, and the cascade only touches rows with
  a dep that is terminal-but-not-`done`. No row is a candidate for both, so
  neither order can spawn something the other would have cancelled. Swapping
  them changes nothing.
- **Dispatch before wake** for two reasons of unequal durability. While step 4
  is awaited (§4.5's open question, §8), it saves a full manager turn of latency
  on every row whose deps just cleared. That reason disappears if the wake stops
  being awaited. The one that survives either way: the manager's first act is
  `synapse status --json`, and dispatching first means it reads rows as
  `assigned` rather than as `unassigned`-and-about-to-start — an accurate picture
  rather than one inviting it to wonder why nothing is running, or to create a
  duplicate.

**The concurrency cap is a resource knob, not a correctness mechanism.** Dispatch
spawns while the count of rows with `stage='assigned'` is below the cap —
`--max-workers N`, default **1** in Tier 1. The count is a query, not watcher
memory, so a restarted watcher re-derives it like everything else (principle 1).
Raising it costs tokens and machine load; it cannot break anything, because what
keeps two writers off one tree is the graph (§2.3.1), not this number. Rev 4 got
serialization as an accident of dispatch happening inside a single-threaded
manager turn; the cap replaces that accident with a stated default, and nothing
load-bearing rests on the default being 1.

**Ties break by `id`.** When more rows are ready than the cap allows, dispatch
takes them in ascending `id` order. Creation order is the manager's choice, so
this hands priority back to the manager without a priority column, without a
dispatch veto, and without the controller judging anything. It is also
deterministic, which the tests need.

**Dispatch asserts on worktree collision.** Before spawning, if the row's
resolved `worktree_path` already holds a live worker, dispatch **refuses the row**
— it does not queue it — leaves it `unassigned`, and writes a NOTE naming both
rows. This is not a second scheduler: it decides no order and delays nothing that
would otherwise have run. It exists because a missing ordering edge (§2.3.1) is
otherwise silent, and its only symptom is two workers overwriting each other's
files. Refusing loudly turns that into a signal, the same move issue-3-style
write-time validation makes for cycles. A refused row is retried on the next
poll, so an edge the manager adds afterwards resolves it with no other
intervention.

**An open QUESTION does not pause dispatch.** A QUESTION blocks the *manager's
decision*, not the run: the manager's turn ends and its next decision waits for
the `ANSWER`, while ready rows keep being spawned. This is deliberate, and it is
not a property inherited from rev 4 — a rev 4 manager was woken by every worker
transition regardless of its own pending question and could dispatch on any of
those wakes, so "pause on question" was never a mechanism, only something a
manager might choose.

Making it a mechanism would hand a model a global switch it did not ask for: one
incidental clarification ("tabs or spaces?") would freeze every task in the run,
against principle 5's standing team. The case that motivates pausing — a review
that found the whole approach wrong, where continued work is certain waste — is
better served by §4.6 source 2, which is precise (only the affected rows),
visible (`cancel_reason` is in the tables), and confined to one goal. Cancel the
rows; do not ask a question at the scheduler.

There is therefore exactly one lever on dispatch: **whether a row exists**. Every
"why is this row not running?" has one place to look.

**Manager turns.** The first wake **creates** the manager session: the watcher
starts a persistent interactive Claude Code process in a named tmux pane
(§4.9, D8) and sends the wake prompt into it. Every later wake **sends the next
wake prompt into the same pane** — the process never exits between turns. The
watcher distinguishes create from send by `runs.manager_turns`, which is `0`
until the first turn completes and is incremented after each. A turn that fails
before completing leaves the counter alone, so the next wake correctly retries
session creation rather than sending into a pane that was never established.

A manager turn **ends when the manager calls `synapse turn-done`** (§5), not
when a process exits — the process is persistent. The watcher issues the wake,
then waits for that DB write before proceeding (see "step 4 blocks" below). A
turn that ends without calling `turn-done` is caught by a per-wake timeout: the
watcher stops waiting, leaves `manager_turns` and `delivered` alone (the batch
is carried again next wake, §4.2), and records a NOTE. Completion is thus a
table fact, consistent with principle 1.

The watcher is the **only** thing that ever wakes the manager, and it is
single-threaded. Mutual exclusion is therefore structural, not enforced by a
lock: the watcher sends one wake into the pane and blocks on the `turn-done`
write before sending another, so at most one turn is ever in flight in the one
pane. (Two overlapping wakes into a single interactive session would interleave
into one confused turn — this is the invariant that prevents it.) This is why
`synapse init` creates the run and first task but spawns nothing, and
`synapse start` only hands off to the watcher.

The invariants are:

- **At most one manager turn in flight.** (Structural, above: one pane, one
  wake at a time, watcher blocks on `turn-done`.)
- **At most `cap` workers alive.** (Dispatch runs in the same single-threaded
  poll loop and counts from the tables.)
- **No transition left undelivered.** (`delivered` is written only after a turn
  that carried the row completes, §4.2 — a property of the data, not of turn
  ordering.)

Dispatch creates no debt (§4.2) and therefore never wakes the manager. This is
correct rather than convenient: the manager owes a reaction to a *result*, not
to a row having started. Were dispatch to create debt, every spawn would wake a
manager that has nothing yet to judge.

Note that "exactly one wake per transition" is *not* an invariant and is not
wanted: several transitions arriving during a busy turn should coalesce into one
follow-up wake.

Workers are never polled or nudged; a worker runs because its row became ready
and finishes when its process exits.

**Step 3 does not block; step 4 does.** The two are on different timescales and
get different treatment.

A worker runs for minutes. Awaiting it inline would stop the poll loop for that
whole time — no sweep, no cascade, and no reaction to an operator message until
the worker exits — which at `--max-workers 1` is the normal state of the system,
not an edge case. Dispatch therefore **claims synchronously and supervises
asynchronously** (§4.5): the spawn and the row write happen inline, so the cap
count is correct before the next candidate is considered, and the wait on the
child runs outside the loop.

A manager turn runs for seconds. Step 4 stays awaited: the watcher issues the
wake into the pane and blocks on the `turn-done` write (or the timeout). This
buys two things worth more than the seconds it costs: mutual exclusion stays
**structural** — `watchLoop` is the only caller and it is sequential, so a
second wake into the one pane cannot overlap the first — rather than resting on
a flag; and dispatch-before-wake keeps its meaning, since a row whose deps
clear starts a full turn earlier than it otherwise would.

The watcher holds its in-flight supervisions so that shutdown can drain or kill
them rather than orphaning workers.

### 4.5 Guaranteed worker exit signal

Liveness is not tracked, but a worker's exit must always become a subtask
transition. Three mechanisms, in order of when they fire:

1. **Stop hook (prevention).** On the worker's turn end, if no `synapse reply`
   has been recorded for its subtask, the hook blocks the stop with "you have not
   called `synapse reply` for subtask N." This catches the common case — a model
   that believes it is finished, or that narrated an error in prose instead of
   writing it to its row — by making it finish properly. It does not fire on
   OOM, non-zero exit, kill, or context-limit abort.
2. **Spawn wrapper (primary).** `synapse spawn` splits in two. The **claim** is
   synchronous: spawn the child, then one `BEGIN IMMEDIATE` writing
   `stage='assigned'`, `worker_session_id` and `worker_pid` together. (Spawning
   before the write means there is no window in which a row is `assigned` with a
   NULL pid; if the write fails, kill the child.) The **supervise** is not
   awaited by its caller: when the child exits with no reply landed, it writes
   `stage='failed'`, `result_summary = "<exit code>; <tail of stderr>"`, and
   leaves `delivered=0`. Unconditional; catches everything the hook misses.

   Because supervision is not awaited, a watcher that dies with workers in flight
   loses their exit handlers. Those rows stay `assigned` until their pids go and
   are then caught by layer 3. **The guarantee survives; the exit code and stderr
   tail do not.** This is the deliberate price of a poll loop that keeps running,
   and it is why layer 3 is not optional.
3. **Watcher pid sweep (backstop).** Each poll, any row with `stage='assigned'`
   whose `worker_pid` is gone → `failed`. Costs one column and survives a
   controller or wrapper crash.

`failed` is an ordinary subtask transition, not an exception path: the manager
judges it like any other and typically responds by creating a replacement row.

### 4.6 Cancellation

Three sources, all real:

1. The operator cancels a goal → cascade to that task's non-terminal rows.
2. The manager decides a planned row is unnecessary (e.g. a review found the
   whole approach wrong).
3. **A dependency did not succeed.** With `depends_on`, a row whose dep ended
   `failed` or `cancelled` can never become ready. The watcher cancels it
   mechanically — `cancel_reason = "dependency <id> failed"` — with no manager
   judgment required. Without this path such rows sit in `unassigned` forever and
   block `synapse done`.

**The cascade cannot tell an ordering edge from a semantic one**, and it cancels
on both. A fix-round row `[7, 8, 9]` that waits on tester 9 only to stay off its
tree (§2.3.1) is cancelled when 9 is cancelled — but "the test was abandoned"
is not a reason to abandon the fix. This over-reach is not specific to
mutual-exclusion edges; any dependency that means "after" rather than "because
of" has it. It is left as over-cancellation rather than fixed with an edge-kind
column, because `cancelled` is a state the manager judges like any other and can
respond to by creating a replacement row, whereas a second edge kind would have
to be understood correctly by a model at every write. Recorded in §8.

All three sources write `delivered=1` in the same transaction as the cancel
(§4.2): none of them has anything to show the manager, because in each case the
decision has already been made — by the operator, by the manager itself, or by
the dependency graph. A cascade that cancels a dozen rows therefore adds nothing
to the next batch.

Cancelling an `assigned` row kills the worker's **process group**, not just
`worker_pid` — a worker's own tool subprocesses must die with it, or a cancelled
row leaves orphans holding its worktree, which then poisons any row that inherits
that tree (§4.7). Workers are therefore spawned into their own process group.

`synapse reply` against a row already in `cancelled` or `failed` is **rejected**,
so a killed worker's dying write cannot revive it.

`synapse done` gates on the derived view (§2.2): the run may close when every
task is terminal — `work_closed`, or cancelled. Nothing is gated on a stored
completion flag, because there is none.

### 4.7 Worktrees

A row's `worktree_path` is assigned at dispatch by one rule that composes with
`depends_on`:

- **No deps** → a fresh git worktree.
- **Has deps** → inherit the worktree of the first dep (its subject).

A reviewer and tester therefore read exactly what their coder wrote, with no
merge step in between.

**Tier 1 serializes**: at most one running worker, acting in the repo directly —
by `--max-workers 1` (§4.4), which is a default, not a guarantee. The guarantee
that survives raising it is narrower and lives in the graph: two rows sharing a
`worktree_path` do not run together if either writes (§2.3.1). The column exists
and is uniform. Concurrent coders in separate worktrees is a Tier 2+ feature —
a real feature with its own validation, not a config change.

Note the divergence to settle before Tier 2: this section says a row with no deps
gets a *fresh* worktree, while the Phase 4 implementation gives it the repo root
on the grounds that Tier 1 has no isolation problem to solve. Under the latter
every row shares one tree, so the graph rule does all the work; under the former
independent roots get independent trees and may legitimately run in parallel. It
is no longer a correctness question — only a question of where parallelism
becomes possible.

### 4.8 Sessions

The controller generates the worker's session UUID and passes `--session-id` at
spawn, so `worker_session_id` is populated at spawn and never NULL afterward.
Workers are one-shot: `--resume` is not used in Tier 1.

The future case that changes this is a fix-round after a bad review. That is a
**new row** (per the 1:1 rule) whose worker resumes the original coder's session
so it retains the implementation context. Hence the warning in §2.3.2 that
`worker_session_id` is not unique across rows.

### 4.9 The manager's context and compaction

**The manager is a persistent *tmux session*: one long-lived interactive Claude
Code process in a named pane that never exits between turns.** The watcher wakes
it by sending the wake prompt into the pane and waits for the manager to signal
completion with `synapse turn-done` (§5). Nothing about the transcript is
reloaded from disk per wake — the accumulated context lives in the resident
process.

`runs.manager_session_id` names the tmux session/pane (derived from the run id,
so it is stable across watcher restarts); `manager_turns` distinguishes the
first wake (create the pane) from later wakes (send into it). A watcher that
dies re-attaches to the existing pane on restart rather than starting a second
manager — the pane, not a process the watcher holds, is the session's home.

Two consequences follow, and neither is optional:

1. **The stateless-turn contract is the mechanism, not a safety net.** As the
   context fills, Claude Code's built-in auto-compaction summarizes it — the
   tmux model does not avoid this, it compacts the same in-process context. The
   failure this creates is concrete: a compacted manager's summary says
   "building the auth module, coder work in progress" — coherent enough to act
   on, but unaware that subtask 5 failed and 9 was cancelled — so it writes a
   verdict on work it misremembers, or creates a replacement row for a row that
   already has one. Since rev 5, *dispatch* is no longer among the things it can
   get wrong (§4.3); that narrows the blast radius without closing it, because
   row creation and judgment still run on whatever picture the manager holds
   when it wakes. So the wake prompt opens with a standing instruction:

   > Before deciding anything, run `synapse status --run <id> --json`. Your
   > context may have been compacted; the tables are authoritative. Your work
   > this turn is the batch named in your prompt — judge each row with
   > `synapse verdict` where a ruling is warranted. **You will not be shown this
   > batch again**, so do not defer a row to a later turn; if you cannot judge
   > it now, say so with `synapse ask`. When you are finished, call
   > `synapse turn-done` — the watcher is waiting on it and will not wake you
   > again until you do.

2. **Manager verbosity is a real budget, though a different one than before.**
   The transcript is no longer reloaded from disk each wake, so per-turn latency
   no longer scales with transcript size the way `--resume` made it. But the
   resident context window still fills, and a fuller window compacts sooner and
   degrades judgment (consequence 1). Verdicts stay short; detail goes to
   artifacts on disk, which cost nothing to carry.

Its accumulated context is an optimization, never a dependency.

**Turn completion is a table fact, with a timeout backstop.** The manager ends
its turn by calling `synapse turn-done`; the watcher observes that DB write and
proceeds. A manager that finishes without calling it would leave the watcher
waiting forever, so the wake carries a timeout: on expiry the watcher stops
waiting, leaves `manager_turns` and the batch's `delivered` flags alone (so the
batch is carried again, §4.2), and records a NOTE naming the stalled turn. This
is the one place the tmux model is weaker than a process that exits on its own —
there, `proc.exited` was the completion signal and could not be forgotten. The
timeout keeps a forgotten `turn-done` from wedging the run, at the cost of a
wasted wake interval.

### 4.10 Storage

The database *is* the coordination substrate, so its settings are part of the
design, not an implementation detail:

- `journal_mode = WAL` — concurrent readers (operator UI, watcher) alongside a
  writer.
- `busy_timeout = 5000` — workers, watcher, and manager all write.
- `foreign_keys = ON`.
- **`BEGIN IMMEDIATE` for every writing transaction.** Every terminal-write path
  reads (check the row's stage) then writes (set stage). Two
  deferred transactions doing that concurrently must both upgrade their locks and
  deadlock — and `busy_timeout` does not rescue an upgrade, which returns
  `SQLITE_BUSY` immediately rather than retrying. This is the common path, not an
  edge case.
- The delivery write is one transaction covering the whole batch, issued after
  the turn completes — never per row as the turn proceeds, or a turn that dies
  half-way would deliver half a batch.
- Watcher poll interval: 2s (a floor on reaction latency; the operator's own view
  is not gated by it).
- The cap counts `stage='assigned'` rows (§4.4). A worker that has committed
  `done` but not yet exited is therefore not counted, so its successor can start
  a few hundred milliseconds before it dies. Under §2.3.1's graph rule the two
  are only ever in one tree if an edge already separates them, so the overlap is
  harmless — but it is real, and a test that assumes strict process-level
  serialization at `--max-workers 1` will be flaky.
- Database location: `.synapse/synapse.db`, per target repo.

### 4.11 Plan approval

Approval is a `QUESTION`, not its own verb and not a column. The manager writes
the planning artifacts, asks a QUESTION with options (approve / revise / cancel),
and stops. Dispatch is blocked by construction, because no subtask rows exist
yet — and since rev 5 that is the *only* reason, since an open QUESTION does not
pause dispatch (§4.4). The manager must therefore not materialize rows before the
answer lands. This is a stronger guarantee than a pause would be, not a weaker
one: a row that does not exist cannot run, whereas a pause is a rule that has to
hold. The operator's `answer` is undelivered operator traffic, which the next
scan picks up first (§4.2), waking the manager to materialize the plan's rows and
their edges.

No approval state is stored on `tasks`: the answered QUESTION is the record, and
the existence of subtask rows is its observable consequence.

---

## 5. Commands

Built in three tiers; each tier is independently demonstrable.

### Tier 1 — the core worker loop
- `synapse init --goal "<text>"` — create a run, its first REQUEST + task; print
  the run id. Pure database write; starts nothing.
- `synapse spawn <role> <subtask-id> [--model M] [--prompt-file F]` — launch a
  one-shot worker (headless `claude -p --session-id`, run-and-exit); wraps the
  child and guarantees a terminal write (§4.5). Invoked by the watcher at
  dispatch; remains available to the operator as a manual override.
- `synapse task <role> "<title>" --task-id T [--depends-on 7,9]` — the manager
  creates a subtask row (up front or on the fly). Creation only: the watcher
  spawns it once it is ready (§4.3).
- `synapse verdict <subtask-id> "<ruling>"` — the manager's ruling on a terminal
  row. Writes `verdict` and nothing else; delivery is the watcher's (§4.2).
- `synapse reply <subtask-id> "<result>" [--handoff <kind>:<file>]` — a worker's
  last act: write its result to its row, stage → done; then it exits.
  (Worker-only. The operator's answer verb is `synapse answer`, so there is no
  id-space collision.)

### Tier 2 — close the loop + operator visibility
- `synapse watch --run R [--max-workers N]` — the background watcher: sweep,
  cascade, dispatch, wake (§4.4). Attaches to an *existing* run, so a watcher
  that dies is restarted without touching the run. `--max-workers` defaults to
  1 in Tier 1.
- `synapse start --goal "<text>"` — `init` then `watch`; the operator's normal
  entry point.
- `synapse status [--run R] [--json]` — the one read verb: run → tasks →
  subtasks, with deps and readiness. `--json` is the manager's machine read;
  without it, the operator's human render. (The web UI is the same read.)
- `synapse turn-done [--run R]` — the manager's last act each turn: signals the
  turn is complete so the watcher stops waiting and proceeds (§4.4, §4.9).
  Manager-only; writes no row state, only the completion signal the watcher
  observes. It does **not** touch `delivered` — the watcher writes that (§4.2).
- `synapse done` — close the run; gates on `task_progress` (§2.2, §4.6).

### Tier 3 — the human conversation + planning
- `synapse request "<goal>"` — operator sends a follow-up goal (REQUEST → task).
- `synapse ask "<q>" --options a,b,c [--title T]` — manager asks a question that
  blocks its own next decision, not dispatch (§4.4).
- `synapse answer <question-id> "<text>"` — operator answers (routes by `ref_id`).
- `synapse say "<text>"` — plain note, either direction.
- `synapse doc <spec|plan|testplan> <task-id> <file>` — write a planning artifact
  to its canonical path, `.synapse/artifacts/task-<id>/<kind>.md`.

---

## 6. What is proven, and how (validation)

Each behavior below is a checkable claim; details map to the validation plan.

- A worker carries full context across a fresh headless `claude -p`, does a real
  tool loop in one invocation, and exits. **(Validated first; the model depends
  on it.)**
- A subtask row is judge-complete on its own: stage + result + artifact + verdict,
  with no field overwritten by a second worker.
- Review and test are sibling rows: a coder row, its reviewer row, and its tester
  row each carry their own result and verdict, linked by `depends_on`.
- A row is not dispatched until its deps are `done`; readiness is recomputable
  from the tables alone.
- **A ready row is spawned by the watcher with zero manager wakes** — create a
  ready row while no debt is outstanding and assert it runs and no manager turn
  was started.
- The concurrency cap holds: with `--max-workers 1`, a second ready row does not
  spawn until the first row is terminal; and raising it does not let two rows
  sharing a `worktree_path` run together.
- Ready rows above the cap are dispatched in ascending `id` order.
- **A worktree collision is refused, not queued**: a row whose tree already holds
  a live worker stays `unassigned`, a NOTE names both rows, and adding the
  missing edge lets the next poll proceed with no other intervention.
- An ordering-only edge behaves as a gate in every respect, including being
  cancel-cascaded when its target is cancelled (the known over-reach, §4.6).
- A worker death and the cancellation of its dependents land in the same poll,
  producing **one** manager wake rather than two. (Note the weaker claim that a
  doomed row is "cancelled rather than spawned" is vacuous — such a row is never
  ready — so it is not a test.)
- A row whose deps clear is `assigned` by the time the manager's `status --json`
  runs in the same poll.
- The poll loop keeps working while a worker runs: with a long-running worker in
  flight, a sweep, a cascade and a manager wake all still occur.
- A watcher killed with a worker in flight leaves that row to the layer-3 sweep;
  the row still ends `failed`, with the exit detail absent rather than the row
  stuck.
- An unanswered QUESTION does **not** stop dispatch: a ready row spawns while a
  manager question is outstanding. Approval still holds, because no rows exist
  until the answer lands (§4.11).
- **A worker killed mid-flight becomes `failed`** — verified three
  ways: a worker that stops without replying (hook), a worker `kill -9`'d
  (wrapper), and a worker orphaned by killing the wrapper (sweep).
- A transition landing *during* a manager turn is delivered on a later turn — not
  by turn ordering, but because it was not in the batch.
- **A turn that dies mid-way delivers nothing.** Kill the manager turn after it
  writes one verdict; assert the whole batch is still `delivered=0` and the next
  wake carries all of it.
- **A completed turn delivers its whole batch, judged or not.** Judge three of
  five; assert all five are `delivered=1` and the next wake does not carry the
  other two.
- The health NOTE names exactly those two: terminal, `delivered=1`,
  `verdict IS NULL`.
- N transitions under one task during one manager turn are carried in one
  following turn, not N.
- Operator messages are scanned ahead of task work: an ANSWER landing while two
  tasks carry undelivered rows is carried first.
- Tasks are taken in ascending `id`; a task with no undelivered rows is skipped.
- **A cascade adds nothing to the next batch**: fail a coder row, assert its
  reviewer and tester are `cancelled` with `delivered=1`, and that the next wake's
  batch contains only the `failed` row.
- A `failed` row is **never** born delivered, and is carried even though the write
  that produced it was mechanical.
- The manager has no verb that writes `delivered`; `synapse verdict` leaves it
  untouched.
- At most one manager turn is in flight at any time under concurrent
  transitions (one pane, watcher blocks on `turn-done` before waking again).
- A follow-up REQUEST creates a new task; the manager plans and materializes
  subtasks under it; a run can carry several tasks.
- A NOTE does not create a task; a REQUEST does.
- The manager's decisions survive a forced compaction: the next turn re-reads the
  tables and judges correctly against rows it has no memory of, creating no
  duplicate or contradictory rows. (Dispatch is no longer part of this claim —
  it is the watcher's, which is the point of §4.3.)
- The operator's view reflects a worker's result with no manager relay hop.
- Illegal message shapes (QUESTION without options, REQUEST from the manager,
  ANSWER without ref_id) are rejected.
- A built-in role spawns with no flags; `--prompt-file` overrides without a
  rebuild.
- A failed dep cancel-cascades its dependents, and cancelled rows do not block
  `synapse done`.
- `synapse reply` against a cancelled or failed row is rejected.
- `synapse done` gates on the derived view: run done ⇔ every task `work_closed`
  or cancelled ⇔ every subtask terminal **and delivered**; a task with zero
  subtasks is not terminal.
- **`work_closed` waits for delivery.** Drive every subtask of a task terminal
  but let no manager turn run; assert `work_settled` is true, `work_closed` is
  false, and `synapse done` still blocks.
- A manager that creates a follow-up row during its turn keeps the task open; one
  that creates none closes it, with no verb called either way.
- The first wake creates the manager's tmux pane and later wakes send into it;
  a turn that fails before completing does not consume the first-turn path.
- A manager turn ends on `synapse turn-done`; the watcher blocks on that write
  and proceeds. A turn that never calls it is released by the timeout backstop,
  which leaves `manager_turns` and the batch's `delivered` flags alone (the
  batch is carried again) and records a NOTE.
- A killed watcher restarts with `synapse watch --run R`, re-attaches to the
  existing manager pane rather than starting a second manager, and the run
  continues, reacting to anything that landed while it was down.
- Approval works with no approval state: the QUESTION is asked, no rows exist,
  the `answer` wakes the manager, the rows appear.
- A cancelled row's worker dies *with its tool subprocesses* — no orphan holds
  the worktree.
- An end-to-end run drives one goal start → plan → approve → code → review →
  done, then a follow-up goal through the same team.

---

## 7. Explicit non-goals

- No direct agent-to-agent message bus; agent work is row writes only.
- No `agents` table — a worker is a subtask row, the manager is the run row.
- No `roles` table / external role config; roles are built into the controller.
- No multi-stage subtask rows; review and test are sibling rows.
- No per-stage timestamp columns; `stage` is authoritative, per-row `delivered`
  drives the watcher.
- No monotonic revision counter and no total order across tables (dropped in
  rev 5; see §4.2 for what that costs).
- No event or inbox table; delivery is a flag on the row that carries it.
- No `ack` verb and no manager-maintained bookkeeping of any kind; the manager's
  only row write is `verdict`.
- No run-level goal text — goals are first-class `tasks` rows.
- No agent liveness tracking as state — only a guaranteed terminal write.
- No Synapse-managed context compaction; rely on the built-in, kept safe by the
  tables plus the stateless-turn contract.
- No parallel workers in Tier 1 — enforced by the watcher's concurrency cap of 1
  (§4.4), no longer an accident of dispatch happening inside a manager turn.
- No manager-side dispatch; the manager creates rows, the watcher spawns them.
- No approval flag on `tasks`; the answered QUESTION is the record.
- No manager-declared task completion; `tasks.status` holds only `open` and
  `cancelled`, and completion is computed as `work_closed` (§2.2).
- No second read verb; `synapse status --json` serves the manager.
- No migration of any prior data; this is a new repository.

---

## 8. Open questions

- **Re-do ergonomics.** After a bad review, is the fix a new coder row resuming
  the original session (§4.8), or a fresh coder row reading the review artifact?
  The first is cheaper in tokens; the second is cleaner and keeps workers truly
  one-shot. Deferred until a real bad review exists to test against.
- **Should the cascade distinguish edge kinds?** §4.6: `depends_on` now carries
  ordering edges that mean "after" rather than "because of" (§2.3.1), and the
  cascade cancels dependents on both. The fix is an edge-kind marker, which
  costs a second thing a model must get right at every write, against an
  over-cancellation the manager can already respond to by creating a replacement
  row. Revisit if over-cancellation actually shows up in Phase 5.
- **Verdict vocabulary.** `verdict` is free text today. If the manager's ruling
  ever needs to drive control flow mechanically, it needs a small enum. Half the
  original motivation is gone: "seen, no ruling" is now `ack` (§4.2), so the enum
  would only ever have to encode outcomes, not the fact of having looked.
- **Manager context telemetry.** Surfacing context usage in the operator UI and a
  manual "compact now" control. Not core.

---

## 9. Implementation decisions

Settled; recorded here because the prompts and schema depend on them.

| # | Decision |
|---|---|
| D1 | **TypeScript on Bun.** `bun:sqlite` is synchronous and ships JSON1 (needed for the `json_each` readiness query); `bun build --compile` gives one binary for workers and hooks to invoke; ~15ms cold start matters because the CLI runs on every worker turn end and every hook fire. |
| D2 | **Per-repo state** at `.synapse/synapse.db`. Worktree paths stay relative; no cross-repo run collisions. |
| D3 | **Artifacts** at `.synapse/artifacts/task-<id>/{spec,plan,testplan}.md`. |
| D4 | **Approval is a QUESTION** (§4.11). |
| D5 | **Per-role model defaults** in the controller, overridable with `--model`. Manager and reviewer get the stronger model. |
| D6 | **One read verb**, `synapse status` (§5). |
| D8 | **Manager runs as a persistent tmux session** (§4.9). One long-lived interactive Claude Code process in a pane named from the run id; the watcher wakes it by sending the wake prompt into the pane and blocks on a `synapse turn-done` DB write (with a timeout backstop) rather than on a process exit. Chosen over repeated `claude -p --resume` to remove per-wake transcript reload and to make the manager's reasoning live-observable by the operator; the cost is that turn completion now depends on the manager calling `turn-done`, which the timeout contains. `manager_turns` still distinguishes create-pane from send-into-pane; `manager_session_id` names the pane and is stable across watcher restarts. |
