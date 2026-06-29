# run_id Enforcement Spec

## Goal

Agents and messages are scoped per-run. The monitor, UI, and mailbox only see
agents and messages belonging to the current run. No cross-run pollution of
status or pending counts.

---

## Schema (v3 → v4)

`agents` table is rebuilt (SQLite cannot drop a PRIMARY KEY in-place):

```sql
CREATE TABLE IF NOT EXISTS agents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  window_name TEXT NOT NULL,
  run_id      INTEGER NOT NULL,    -- 0 = operator sentinel; N = run id (N ≥ 1)
  role        TEXT NOT NULL,
  session_id  TEXT,
  status      TEXT NOT NULL DEFAULT 'unknown',
  last_seen_at TEXT,
  UNIQUE(window_name, run_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id);
```

- `agents.run_id 0`   — operator pseudo-agent (cross-run singleton, sentinel value)
- `agents.run_id N`   — agent belongs to run N (N ≥ 1, from `runs.id` autoincrement)
- Unique key changes from `PRIMARY KEY(window_name)` to `UNIQUE(window_name, run_id)`
- Migration: bump `SCHEMA_VERSION` 3 → 4; existing v3 DBs are backed up and rebuilt (same path as v1 → v2)
- **No ALTER TABLE** — `window_name TEXT PRIMARY KEY` cannot be changed without a table rebuild
- **No NULL for operator** — SQLite treats each NULL as distinct in UNIQUE constraints, so `ON CONFLICT(window_name, run_id)` would not fire for repeated `(operator, NULL)` inserts. Operator uses `run_id = 0` (sentinel) instead; real runs start at 1 via autoincrement.

---

## Registration

`cmdRegister(name, role, sessionId, runId?)`:
- `ON CONFLICT(window_name, run_id)` replaces `ON CONFLICT(window_name)`
- `cmdStart` passes `runId` for each agent, passes `0` for operator (sentinel)
- `synapse register` CLI (synapse.ts ~93): `agents.run_id` is `NOT NULL`, so bare `synapse register <name> <role>` needs a run id. Resolve via `--run-id` flag → `SYNAPSE_RUN_ID` env → `fail()`. No silent default; callers outside `cmdStart` must supply it explicitly.

Operator direct INSERT in `cmdStart` (commands.ts ~1208) also updated:
- Column list includes `run_id = 0`
- Conflict target changed to `(window_name, run_id)`

---

## agents queries — add run_id scoping

`runId` is already in scope at every call site listed below (passed via
`--run-id` flag to the monitor, or available as `activeRun()` in the UI).

| Site | File | Line | Change |
|---|---|---|---|
| `disbandTeam` SELECT | commands.ts | 503 | `AND run_id=?` |
| `disbandTeam` UPDATE stop | commands.ts | 514 | `AND run_id=?` |
| `refreshAgentState` UPDATE status | commands.ts | 480 | `AND run_id=?` |
| `pollOnce` SELECT | commands.ts | 555 | `AND run_id=?` |
| `reloadAgents` SELECT | commands.ts | 671 | `AND run_id=?` |
| `cmdStop` SELECT verify | commands.ts | 1359 | `AND run_id=?` (resolve from env/flag) |
| `cmdStop` UPDATE stop | commands.ts | 1364 | `AND run_id=?` |
| UI `pollDb` agent SELECT | ui.ts | 720 | `AND (run_id=? OR run_id=0)` — `run_id=0` is the operator sentinel, not a catch-all for legacy orphans |
| `cmdStatus` SELECT | mailbox.ts | 84 | scope to active run by default |

---

## messages queries — add run_id scoping

UPDATE/DELETE by `id` are safe (message IDs globally unique — no cross-run
risk). Only SELECT and the `cmdDone` root-task lookup need scoping.

> **`cmdSend` recipient validation** (mailbox.ts ~41): `SELECT 1 FROM agents WHERE window_name=?` can match an agent from a different run once `window_name` is no longer unique. Change to `WHERE window_name=? AND (run_id=? OR run_id=0)` using the resolved `run_id`, so the warning fires correctly when the recipient is absent from the current run.

> **Note on `cmdDone` final STATUS**: `cmdSend("operator", "STATUS", ...)` resolves
> `run_id` via `explicit arg → SYNAPSE_RUN_ID env → null`. `cmdDone` must pass
> `runId` explicitly to `cmdSend` — do not rely on the env fallback, as worker
> shells may not have `SYNAPSE_RUN_ID` set, causing the final STATUS to be
> inserted with `run_id=NULL` and missed by the run-scoped UI/thread.

| Site | File | Line | Change |
|---|---|---|---|
| `dispatchNextDirectMessage` SELECT | commands.ts | 375 | `AND run_id=?` |
| `hasPendingDirectMessageForWindow` SELECT | commands.ts | 388 | `AND run_id=?` |
| `broadcastReadyMessages` SELECT | commands.ts | 404 | `AND run_id=?` |
| `dispatchDirectMessage` UPDATE delivered | commands.ts | 350 | no change (by id) |
| `dispatchDirectMessage` UPDATE failed | commands.ts | 360 | no change (by id) |
| `broadcastReadyMessages` UPDATE | commands.ts | 426 | no change (by id) |
| `cmdDone` root TASK lookup | commands.ts | 1342 | `AND run_id=?` |
| `cmdStatus` pending count | mailbox.ts | 90 | `AND run_id=?` |
| `cmdPending` SELECT (by agent) | mailbox.ts | 167 | scope to active run; `--all` to override |
| `cmdPending` SELECT (all) | mailbox.ts | 174 | scope to active run; `--all` to override |

> **CLI change required for `--all`**: today `synapse.ts` calls `cmdPending(positional[0] ?? null)` and ignores flags. Must thread `flags["all"]` through: `cmdPending(positional[0] ?? null, !!flags["all"])` and update the `cmdPending` signature accordingly. Without this the `--all` override is documented but nonfunctional.
| `cmdDeliver` UPDATE | mailbox.ts | 206 | no change (by id) |
| UI thread fallback SELECT | ui.ts | 686 | acceptable (no-run fallback, last 200) |
| UI stream fallback SELECT | ui.ts | 744 | acceptable (no-run fallback) |

---

## run_id threading in monitor

`runId` is already threaded through the monitor call chain:

```
cmdMonitor → pollOnce / runLiveMonitor
          → disbandTeam / refreshAgentState
          → dispatchNextDirectMessage / broadcastReadyMessages
```

Each function needs `runId` added to its signature and passed into SQL.

---

## Out of scope

- `cmdRuns` — shows all runs intentionally, no change
- `cmdDeliver` — operates by message id, safe
- UPDATE by id in dispatch — safe
- `probeSchema` / schema probe queries — not data queries
