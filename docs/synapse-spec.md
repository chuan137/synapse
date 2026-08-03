# Synapse — Design Specification

> A multi-agent coordination system: several Claude Code sessions work as a
> team on one or more goals, coordinating through a shared SQLite database.

Status: DRAFT rev 3 — pending operator approval.
Change history in §9. Implementation decisions in §10.

---

## 1. Overview

Synapse runs a team of AI agents against an operator's goals. One **manager**
agent decomposes each goal into units of work and dispatches them to short-lived
**worker** agents (coders, reviewers, testers, and other roles). All
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
   time. Each goal is a task; the manager plans and dispatches work under it.
6. **Small surface.** Four tables, roughly a dozen commands, one background
   watcher.

---

## 2. Data model

Four tables. There is no `agents` table (a worker is a subtask row; the manager
is the run row) and no `roles` table (roles are built into the controller, §3).

### 2.1 `runs` — the team / session (holds the persistent manager)

| Column | Type | Meaning |
|---|---|---|
| `id` | INTEGER PK | run id |
| `status` | TEXT | `running` \| `done` \| `failed` |
| `manager_session_id` | TEXT | the manager's Claude session UUID (the watcher resumes it); the run row *is* the manager's record |
| `manager_model` | TEXT | the manager's Claude model |
| `rev_counter` | INTEGER | monotonic counter for this run; source of all `rev` values (§4.2) |
| `manager_reacted_rev` | INTEGER | high-water-mark: the latest `rev` the manager has already reacted to |
| `manager_turns` | INTEGER | turns run, incremented after each; `0` means the session does not exist yet (§4.4) |
| `created_at` | TEXT | ISO timestamp |
| `ended_at` | TEXT | ISO timestamp, NULL until closed; the manager's "completed_at" is the run's |

The run holds **no goal text** — goals live in `tasks`. The run is a standing
team, not a single goal. The manager is 1:1 with the run (one persistent process
spanning all its tasks), so it needs no row of its own.

### 2.2 `tasks` — a goal from the operator

The operator's goals. The initial goal at `synapse start` is the first task
row; each follow-up goal adds another. A task is created by an operator
`REQUEST` message (§2.4).

| Column | Type | Meaning |
|---|---|---|
| `id` | INTEGER PK | task id |
| `run_id` | INTEGER FK | the team this goal belongs to |
| `text` | TEXT | the goal as the operator stated it |
| `status` | TEXT | `open` → `planning` → `running` → `done`; or `cancelled` |
| `source_message_id` | INTEGER FK | the operator `REQUEST` message that stated this goal |
| `created_at` | TEXT | ISO timestamp |
| `done_at` | TEXT | ISO timestamp, NULL until terminal |

`tasks.status` is the manager's **declaration**, not the ground truth. Whether a
task's work is finished is *derived* from its subtasks, exposed as a view:

```sql
CREATE VIEW task_progress AS
SELECT t.id, t.run_id, t.status,
       COUNT(s.id)                                          AS n_subtasks,
       SUM(s.stage IN ('done','failed','cancelled'))        AS n_terminal,
       COUNT(s.id) > 0
         AND COUNT(s.id) = SUM(s.stage IN ('done','failed','cancelled'))
                                                            AS work_settled
FROM tasks t LEFT JOIN subtasks s ON s.task_id = t.id
GROUP BY t.id;
```

`work_settled` is false for a task with **zero** subtasks — a goal that has been
stated but not yet planned is not finished. A task is terminal when
`work_settled` is true and the manager has set `status='done'`, or when
`status='cancelled'`. `synapse done` gates on the view, never on stored status
(§4.6).

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
| `rev` | INTEGER | the `rev` of the last transition on this row that the manager owes a reaction to (§4.2) |
| `created_at` | TEXT | ISO timestamp |
| `updated_at` | TEXT | ISO, for humans only — **not** used for control |

Terminal stages: `done`, `failed`, `cancelled`.

#### 2.3.1 `depends_on` does two jobs

It is both the **dispatch gate** ("do not spawn until these are `done`") and the
**subject pointer** ("this is the row I am reviewing"). A reviewer row for
subtask 7 has `depends_on = [7]`; a tester row that needs both the code and a
fixture has `[7, 9]` and its subject is 7. The controller passes the subject
row's `artifact_path` and `worktree_path` into the worker's prompt.

The gate replaces rev 1's `needs_review` / `needs_test` columns: "review is
required" is now expressed by a reviewer row existing.

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
| `rev` | INTEGER | assigned iff `author='operator'`; NULL otherwise (§4.2) |
| `created_at` | TEXT | ISO timestamp |

`to_agent` is dropped: only two identities exist, so the recipient is whoever
the author is not. `author` is kept (rather than deriving direction from `type`)
because `NOTE` is legal in both directions.

Message types — each is a distinct CLI verb, so the type is never inferred from
the text:

| verb | type | author | behavior |
|---|---|---|---|
| `synapse request "<goal>"` | REQUEST | operator | **creates a `tasks` row** |
| `synapse ask "<q>" --options a,b,c` | QUESTION | manager | blocking; UI renders a card; `options` required |
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

- **`manager`** — plans each goal, dispatches work, judges results, converses
  with the operator. Persistent (one per run; it is the run row).
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

---

## 4. How it works

### 4.1 The lifecycle of a run

```
operator: synapse start --goal "build X"      (= init, then watch)
  synapse init:
    → create runs row (status=running, rev_counter=0, manager_turns=0)
    → generate manager_session_id (not yet used — no session exists)
    → create the first REQUEST message + its tasks row, print the run id
  synapse watch --run <id>:
    → start the watcher
    → (start does NOT spawn a manager turn directly — the watcher does, §4.4)

manager (persistent = the run row), woken by the watcher:
  → FIRST ACT, ALWAYS: synapse status --run <id> --json  (§4.9)
  → new REQUEST? → plan: write spec / plan / testplan docs; ask operator to approve
  → on approval: materialize the plan's subtask rows up front
    (stage=unassigned, with depends_on edges — coder, then its reviewer,
     then its tester, as sibling rows)
  → dispatch: for every READY row (stage=unassigned and all deps done),
    spawn a one-shot worker
  → may also create rows ON THE FLY during execution
  → its turn ends; the process exits, the SESSION persists (§4.9)

worker (one-shot = a subtask row):
  → claude -p --session-id <uuid>: read its row + its subject's artifact, work
  → synapse reply <subtask-id> "<result>" [--handoff <kind>:<file>]
      (writes result_summary + artifact_path, stage=done, assigns a rev)
  → process exits
  → if it exits WITHOUT replying, the wrapper writes stage=failed (§4.5)

watcher (background, polling):
  → any rev > runs.manager_reacted_rev (subtask transition or operator message)?
  → cancel-cascade any row whose deps are terminal-but-not-done (§4.6)
  → wake exactly one manager turn (claude -p --resume <manager_session_id>)

manager (woken):
  → judge each newly-terminal row (write `verdict`), decide next
      (dispatch newly-ready rows, or create follow-up/re-do rows)
  → a task's work settled and accepted → set tasks.status=done
  → all tasks terminal → synapse done

operator (throughout):
  → reads the tables directly (live view) — each result the moment it is written,
    no manager relay
  → sends follow-up goals (synapse request); answers questions (synapse answer)
```

### 4.2 `rev`: one monotonic signal

Every write **that the manager owes a reaction to** takes the next value of
`runs.rev_counter`, in the same transaction as the write:

```sql
UPDATE runs SET rev_counter = rev_counter + 1 WHERE id = ? RETURNING rev_counter;
```

Writes that assign a rev:
- a worker's `synapse reply` (stage → done)
- a wrapper/sweep failure write (stage → failed)
- a cancel-cascade (stage → cancelled)
- any **operator**-authored message (REQUEST, ANSWER, NOTE)

Writes that do **not** assign a rev: everything the manager itself does —
verdicts, row creation, dispatch, task status, its own QUESTIONs and NOTEs.
Otherwise the manager would wake itself in a loop.

This collapses rev 1's two watcher signals into one and removes two bugs that
timestamp-based high-water-marks have:

- **Mid-turn loss.** Rev 1 advanced the mark to wall-clock-now at turn end, so a
  transition landing *during* a manager turn fell behind the mark and was never
  reacted to — a completed subtask nobody judged, and a stalled run.
- **Same-second collisions.** ISO-second granularity with `>` merged two
  transitions in the same second into one, or dropped one depending on `>` vs
  `>=`.

The watcher therefore reads the mark **before** the turn and writes it **after**:

```
rev_seen = max(rev) across subtasks + messages for this run   # before
run one manager turn (blocking)
runs.manager_reacted_rev = rev_seen                           # after
```

Anything that lands mid-turn has `rev > rev_seen` and fires on the next poll.
Coalescing (N transitions during one turn → one follow-up wake) and no-loss both
fall out of this ordering.

`updated_at` remains on `subtasks` for humans reading the table. It is not used
for control.

### 4.3 Readiness and dispatch

A row is **ready** when `stage='unassigned'` and every id in `depends_on` has
`stage='done'`. The manager dispatches ready rows during its turn. Because the
edges are stored, a freshly-compacted manager can recompute readiness from the
tables alone — ordering never lives only in context.

### 4.4 The trigger model

One persistent background component — the **watcher** — does one job: wake the
manager when it owes a reaction (`max(rev) > manager_reacted_rev`).

The first wake **creates** the manager session (`claude -p --session-id
<manager_session_id>`); every later wake **resumes** it (`--resume`). The watcher
distinguishes them by `runs.manager_turns`, which is `0` until the first turn
completes and is incremented after each. A turn that fails before completing
leaves the counter alone, so the next wake correctly retries session creation
rather than resuming a session that was never established.

The watcher is the **only** thing that ever starts a manager turn, and it is
single-threaded. Mutual exclusion is therefore structural, not enforced by a
lock: at most one `claude -p --resume <manager_session_id>` process exists at
any time. (Two concurrent resumes of one session id would fork the transcript —
this is the invariant that prevents it.) This is why `synapse init` creates the
run and first task but spawns nothing, and `synapse start` only hands off to the
watcher.

The invariants are:

- **At most one manager process alive.** (Structural, above.)
- **No transition left unreacted.** (The rev ordering in §4.2.)

Note that "exactly one wake per transition" is *not* an invariant and is not
wanted: several transitions arriving during a busy turn should coalesce into one
follow-up wake.

Workers are never polled or nudged; a worker runs because the manager spawned it
and finishes when its process exits.

### 4.5 Guaranteed worker exit signal

Liveness is not tracked, but a worker's exit must always become a subtask
transition. Three mechanisms, in order of when they fire:

1. **Stop hook (prevention).** On the worker's turn end, if no `synapse reply`
   has been recorded for its subtask, the hook blocks the stop with "you have not
   called `synapse reply` for subtask N." This catches the common case — a model
   that believes it is finished, or that narrated an error in prose instead of
   writing it to its row — by making it finish properly. It does not fire on
   OOM, non-zero exit, kill, or context-limit abort, and does not survive a
   model that keeps getting blocked long enough to exhaust an internal
   ~10-forced-stop retry cap — past that, the CLI silently reports success
   with an empty result despite an active block (spike S0.3). This is exactly
   why layers 2 and 3 are unconditional and never trust the hook or the CLI's
   own exit code.
2. **Spawn wrapper (primary).** `synapse spawn` waits on the child process. If
   the child exits and no reply landed, the wrapper writes `stage='failed'`,
   `result_summary = "<exit code>; <tail of stderr>"`, and assigns a rev.
   Unconditional; catches everything the hook misses.
3. **Watcher pid sweep (backstop).** Each poll, any row with `stage='assigned'`
   whose `worker_pid` is gone → `failed`. Costs one column and survives a
   controller or wrapper crash.

Each mechanism above assumes a worker actually got to attempt its tools. A
worker's tool access is scoped per role via `--allowedTools`, granted at spawn:

| Role | Tools |
|---|---|
| `coder` | `Write`, `Edit`, `Bash`, `Read`, `Glob`, `Grep` |
| `reviewer` | `Read`, `Glob`, `Grep`, `Bash(git *)` — no `Write`/`Edit`: a reviewer judges, it does not modify the row it is reviewing; `git` is a prompt-contract boundary (read commands only), not a pattern-enforced one |
| `tester` | `Read`, `Glob`, `Grep`, `Bash` — runs the validation plan, including build/test commands, but does not edit source |
| `doc-writer` | `Write`, `Edit`, `Read`, `Glob`, `Grep` — writes only under `.synapse/artifacts/` by prompt contract, not by tool restriction |

All roles additionally get `Bash(<synapse-bin-path> *)` and `Bash(printenv
*)`, computed at spawn time rather than listed statically above:

- **The worker's own identity — the synapse binary's absolute path,
  `SUBTASK_ID`, `RUN_ID` — is substituted as literal text into the prompt at
  spawn time**, not read from the environment via shell expansion. A first
  implementation passed these as process environment variables and told
  workers to invoke `$SYNAPSE_BIN`; a real reviewer trial found Claude Code's
  `Bash(pattern *)` allowlist matches literal command text, and denies both
  `$VAR`-expanding commands ("Contains simple_expansion") and the binary's
  resolved absolute path (requires approval) — so `Bash(synapse *)` never
  matched anything the worker could actually run. The corrected design
  substitutes the real absolute path directly into the prompt text before
  spawn (no variable, nothing to expand), and grants
  `Bash(<that same absolute path> *)` — computed per spawn, since the path
  varies by checkout (D2). `Bash(printenv *)` remains granted for debugging
  visibility but is no longer load-bearing for the worker's own identity.
- The `synapse reply` call is mandatory, which is why every role's `Bash`
  grant includes the synapse binary regardless of what else it can run.

A tool-call denial is not a distinct failure mode: a worker that never gets
to write still falls through the layer 2/3 guarantee above like any other
silent exit — headless `-p` mode enforces permissions and exits 0 even when
every tool call was denied (spike S0.1), so the wrapper's "no reply landed"
check is what actually catches it, not the exit code.

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

Cancelling an `assigned` row kills the worker's **process group**, not just
`worker_pid` — a worker's own tool subprocesses must die with it, or a cancelled
row leaves orphans holding its worktree, which then poisons any row that inherits
that tree (§4.7). Workers are therefore spawned into their own process group.

`synapse reply` against a row already in a terminal stage — `cancelled`,
`failed`, or `done` — is **rejected**, so a killed worker's dying write cannot
revive it, and a second worker's late reply cannot overwrite an already-judged
result.

`synapse done` gates on the derived view (§2.2): the run may close when every
task is terminal — `work_settled` and accepted, or cancelled — never on stored
status.

### 4.7 Worktrees

A row's `worktree_path` is assigned at dispatch by one rule that composes with
`depends_on`:

- **No deps** → a fresh git worktree.
- **Has deps** → inherit the worktree of the first dep (its subject).

A reviewer and tester therefore read exactly what their coder wrote, with no
merge step in between.

**Tier 1 serializes**: at most one running worker, acting in the repo directly.
The column exists and is uniform. Concurrent coders in separate worktrees is a
Tier 2+ feature — a real feature with its own validation, not a config change.

### 4.8 Sessions

The controller generates the worker's session UUID and passes `--session-id` at
spawn, so `worker_session_id` is populated at spawn and never NULL afterward.
Workers are one-shot: `--resume` is not used in Tier 1.

The future case that changes this is a fix-round after a bad review. That is a
**new row** (per the 1:1 rule) whose worker resumes the original coder's session
so it retains the implementation context. Hence the warning in §2.3.2 that
`worker_session_id` is not unique across rows.

### 4.9 The manager's context and compaction

**The manager is a persistent *session*, not a persistent process.** Each wake is
a fresh `claude -p --resume <manager_session_id>` process that rehydrates the
transcript from disk and exits when the turn ends. Nothing stays resident.

Two consequences follow, and neither is optional:

1. **The stateless-turn contract is the mechanism, not a safety net.** As the
   transcript fills, Claude Code's built-in auto-compaction summarizes it. The
   failure this creates is concrete: a compacted manager's summary says "building
   the auth module, coder work in progress" — coherent enough to act on, but
   unaware that subtask 5 failed and 9 was cancelled — and it dispatches against
   a remembered plan that no longer matches the tables. So the wake prompt opens
   with a standing instruction:

   > Before deciding anything, run `synapse status --run <id> --json`. Your
   > context may have been compacted; the tables are authoritative.

2. **Manager verbosity is a real budget.** Per-turn latency and token cost scale
   with transcript size, and the transcript is reloaded every turn. Verdicts stay
   short; detail goes to artifacts on disk, which cost nothing to carry.

Its accumulated context is an optimization, never a dependency.

### 4.10 Storage

The database *is* the coordination substrate, so its settings are part of the
design, not an implementation detail:

- `journal_mode = WAL` — concurrent readers (operator UI, watcher) alongside a
  writer.
- `busy_timeout = 5000` — workers, watcher, and manager all write.
- `foreign_keys = ON`.
- **`BEGIN IMMEDIATE` for every writing transaction.** Every rev-assigning path
  reads (check the row's stage) then writes (set stage, bump the counter). Two
  deferred transactions doing that concurrently must both upgrade their locks and
  deadlock — and `busy_timeout` does not rescue an upgrade, which returns
  `SQLITE_BUSY` immediately rather than retrying. This is the common path, not an
  edge case.
- Every rev-assigning write is a single transaction covering the counter bump and
  the row write.
- Watcher poll interval: 2s (a floor on reaction latency; the operator's own view
  is not gated by it).
- Database location: `.synapse/synapse.db`, per target repo.

### 4.11 Plan approval

Approval is a `QUESTION`, not its own verb and not a column. The manager writes
the planning artifacts, asks a QUESTION with options (approve / revise / cancel),
and stops. Dispatch is blocked by construction, because no subtask rows exist
yet. The operator's `answer` assigns a rev, which wakes the manager, which
materializes the plan's rows and their edges.

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
  child and guarantees a terminal write (§4.5).
- `synapse task <role> "<title>" --task-id T [--depends-on 7,9]` — the manager
  creates a subtask row (up front or on the fly) and, if ready, spawns it.
- `synapse reply <subtask-id> "<result>" [--handoff <kind>:<file>]` — a worker's
  last act: write its result to its row, stage → done; then it exits.
  (Worker-only. The operator's answer verb is `synapse answer`, so there is no
  id-space collision.)

### Tier 2 — close the loop + operator visibility
- `synapse watch --run R` — the background watcher (poll rev, cancel-cascade, pid
  sweep, wake the manager). Attaches to an *existing* run, so a watcher that dies
  is restarted without touching the run.
- `synapse start --goal "<text>"` — `init` then `watch`; the operator's normal
  entry point.
- `synapse status [--run R] [--json]` — the one read verb: run → tasks →
  subtasks, with deps and readiness. `--json` is the manager's machine read;
  without it, the operator's human render. (The web UI is the same read.)
- `synapse done` — close the run; gates on `task_progress` (§2.2, §4.6).

### Tier 3 — the human conversation + planning
- `synapse request "<goal>"` — operator sends a follow-up goal (REQUEST → task).
- `synapse ask "<q>" --options a,b,c [--title T]` — manager asks a blocking
  question.
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
- **A worker killed mid-flight becomes `failed`** — verified three
  ways: a worker that stops without replying (hook), a worker `kill -9`'d
  (wrapper), and a worker orphaned by killing the wrapper (sweep).
- A transition landing *during* a manager turn is reacted to on the next poll
  (the mid-turn-loss regression test).
- N transitions during one manager turn produce one follow-up wake, not N.
- At most one manager process exists at any time under concurrent transitions.
- A follow-up REQUEST creates a new task; the manager plans and materializes
  subtasks under it; a run can carry several tasks.
- A NOTE does not create a task; a REQUEST does.
- The manager's decisions survive a forced compaction: the next turn re-reads the
  tables and dispatches correctly against rows it has no memory of.
- The operator's view reflects a worker's result with no manager relay hop.
- Illegal message shapes (QUESTION without options, REQUEST from the manager,
  ANSWER without ref_id) are rejected.
- A built-in role spawns with no flags; `--prompt-file` overrides without a
  rebuild.
- A failed dep cancel-cascades its dependents, and cancelled rows do not block
  `synapse done`.
- `synapse reply` against a row in any terminal stage (`done`, `cancelled`, or
  `failed`) is rejected.
- `synapse done` gates two-level on the derived view: run done ⇔ every task
  terminal ⇔ every subtask terminal; a task with zero subtasks is not terminal.
- The first wake creates the manager session and later wakes resume it; a turn
  that fails before completing does not consume the first-turn path.
- A killed watcher is restarted with `synapse watch --run R` and the run
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
- No per-stage timestamp columns; `stage` is authoritative, `rev` drives the
  watcher.
- No run-level goal text — goals are first-class `tasks` rows.
- No agent liveness tracking as state — only a guaranteed terminal write.
- No Synapse-managed context compaction; rely on the built-in, kept safe by the
  tables plus the stateless-turn contract.
- No parallel workers in Tier 1.
- No approval flag on `tasks`; the answered QUESTION is the record.
- No second read verb; `synapse status --json` serves the manager.
- No migration of any prior data; this is a new repository.

---

## 8. Open questions

- **Re-do ergonomics.** After a bad review, is the fix a new coder row resuming
  the original session (§4.8), or a fresh coder row reading the review artifact?
  The first is cheaper in tokens; the second is cleaner and keeps workers truly
  one-shot. Deferred until a real bad review exists to test against.
- **Verdict vocabulary.** `verdict` is free text today. If the manager's ruling
  ever needs to drive control flow mechanically, it needs a small enum.
- **Manager context telemetry.** Surfacing context usage in the operator UI and a
  manual "compact now" control. Not core.

---

## 9. Changes from rev 1

| # | Change |
|---|---|
| 1 | Subtask rows are strictly 1:1 with workers. Reviewer/tester are sibling rows. `stage` shrinks from six values to `unassigned/assigned/done` + `failed`/`cancelled`. `needs_review`, `needs_test`, `--no-review`, `--test-required` all removed. |
| 2 | Added `depends_on` as both dispatch gate and subject pointer, replacing the removed gate columns and making dispatch order recomputable from the tables. |
| 3 | Added `failed` stage plus a three-layer guarantee that a worker's exit always produces a subtask transition (Stop hook, spawn wrapper, pid sweep). New column `worker_pid`. |
| 4 | Replaced timestamp high-water-mark with a monotonic `rev` from `runs.rev_counter`; `manager_reacted_at` → `manager_reacted_rev`. Fixes mid-turn loss and same-second collisions, and collapses the watcher's two signals into one. |
| 5 | `synapse reply` rejection scope widened from `cancelled`/`failed` (rev 2 §4.6 prose) to all three terminal stages including `done`, matching §6's "no field overwritten by a second worker" claim and the plan's `liar.sh` exit criterion. |
| 5 | Stated the real watcher invariants (at-most-one manager, no unreacted transition) and made mutual exclusion structural: the watcher is the sole spawner of manager turns, so `synapse start` no longer spawns one directly. |
| 6 | Message channel restructured: one verb per type (`request` / `ask` / `answer` / `say`), lifecycle tags dropped, `to_agent` dropped, `from_agent` → `author` (kept because NOTE is bidirectional). Operator `answer` no longer collides with worker `reply`. |
| 7 | Added `worktree_path` and the inherit-from-first-dep rule; Tier 1 explicitly serializes. |
| 8 | Workers spawn with `--session-id`, not `--resume`; `worker_session_id` documented as a non-unique process artifact. |
| 9 | Added the stateless-turn contract to the manager's wake prompt, with the concrete post-compaction failure it prevents. |
| 10 | `tasks.status` demoted to a declaration; terminality derived via the `task_progress` view, with the zero-subtask case defined. |
| 11 | Cancellation given three named sources (including the dependency cascade the watcher performs mechanically), a process kill, and a reject rule for late writes. |
| 12 | SQLite settings (WAL, busy_timeout, foreign keys, poll interval, transaction boundary) promoted into the spec. |

### Changes from rev 2

| # | Change |
|---|---|
| 13 | **Corrected: the manager is a persistent session, not a persistent process.** Rev 2's "stays warm" was wrong — every wake is a fresh process rehydrating the transcript. §4.9 rewritten: the stateless-turn contract is the mechanism, and manager verbosity becomes a real per-turn cost. |
| 14 | Retired "board" as a term. Kept once in §1 as pattern attribution; §2.3's nickname dropped, "board transition" → "subtask transition", principle 1 → "the tables are the truth". It was used at two scopes and reads as Kanban to a fresh reader. |
| 15 | `synapse board` and `synapse status` collapsed into one verb, `synapse status [--run R] [--json]`. They were the same read at two verbosities. |
| 16 | Added §4.11: plan approval is a QUESTION, with no approval state stored on `tasks`. |
| 17 | Cancellation kills the worker's **process group**, not just its pid, so tool subprocesses cannot orphan and hold a worktree. |
| 18 | Added `BEGIN IMMEDIATE` to §4.10 — read-then-write is the common path for every rev-assigning write, and deferred transactions deadlock on upgrade where `busy_timeout` cannot help. |
| 19 | Added §10: settled implementation decisions (runtime, paths, model defaults). |
| 20 | Split `synapse start` into `synapse init` (rows only) and `synapse watch --run R` (process only), with `start` as the wrapper. `watch` now attaches to an existing run, which makes watcher crash recovery an ordinary command rather than a special path. |
| 21 | Added `runs.manager_turns`. The first wake must `--session-id` (no session exists yet) and later wakes `--resume`; nothing previously recorded which turn it was. Doubles as a cheap proxy for transcript size, which §4.9 made a real budget. |
| 22 | Added §4.5's per-role `--allowedTools` table and D7. Spike S0.1 (Phase 0) found the spec silent on what a worker may touch; Phase 4 needed an answer before `prompts/*.md` and `spawn`'s role wiring could be written. |
| 23 | Completed §4.5 bullet 1 (Stop hook) with the internal ~10-forced-stop cap spike S0.3 found: past it, the CLI reports success with an empty result despite an active block. Flagged for a spec diff at Phase 0, applied now that the hook is actually being built (Phase 4). |
| 24 | Corrected §4.5's per-role tool table and D7: added `Bash(printenv *)` as an implicit grant on every role. A real reviewer trial run in Phase 4 hit this immediately — reviewer's read-only `Bash` scope permitted `synapse ...` calls but nothing that could read `$SUBTASK_ID`/`$RUN_ID`/`$SYNAPSE_BIN` in the first place, so it correctly refused to guess its own identity and filed no reply. Row #22's original D7 diff was incomplete; this corrects it rather than adding a parallel decision. Superseded by #25 below, on the very next trial. |
| 25 | Corrected §4.5/D7 again: `Bash(synapse *)` never matched a real invocation — Claude Code's allowlist matches literal command text and denies both `$VAR` expansion and a resolved absolute path. Replaced the "`$SYNAPSE_BIN` env var + `Bash(synapse *)`" design with literal-string prompt substitution (`{{SYNAPSE_BIN}}`/`{{SUBTASK_ID}}`/`{{RUN_ID}}`, filled in by `cmdSpawn` before invoking `claude -p`) plus a per-spawn `Bash(<resolved absolute path> *)` grant. Also added `Bash(git *)` to `reviewer`, matching what its prompt already told it to do. Both gaps were invisible to every fake/mock test in Phases 1–3 and surfaced only once a real model actually tried to act on its own prompt. |

---

## 10. Implementation decisions

Settled; recorded here because the prompts and schema depend on them.

| # | Decision |
|---|---|
| D1 | **TypeScript on Bun.** `bun:sqlite` is synchronous and ships JSON1 (needed for the `json_each` readiness query); `bun build --compile` gives one binary for workers and hooks to invoke; ~15ms cold start matters because the CLI runs on every worker turn end and every hook fire. |
| D2 | **Per-repo state** at `.synapse/synapse.db`. Worktree paths stay relative; no cross-repo run collisions. |
| D3 | **Artifacts** at `.synapse/artifacts/task-<id>/{spec,plan,testplan}.md`. |
| D4 | **Approval is a QUESTION** (§4.11). |
| D5 | **Per-role model defaults** in the controller, overridable with `--model`. Manager and reviewer get the stronger model. |
| D6 | **One read verb**, `synapse status` (§5). |
| D7 | **Per-role `--allowedTools` scope** (§4.5): `coder` gets `Write`/`Edit`/`Bash`; `reviewer` is read-only plus `Bash(git *)`; `tester` is read-only plus unscoped `Bash` to run validation commands; `doc-writer` gets `Write`/`Edit` scoped by prompt contract to `.synapse/artifacts/`. Every role additionally gets `Bash(<synapse-bin-path> *)` (path resolved per spawn) and `Bash(printenv *)`. Found underspecified at spike S0.1 (Phase 0); settled before Phase 4 prompts were written, then corrected twice more by real trial runs in Phase 4 — see §9 #24–25. |
