// spec §4.2 (delivery / wake condition), §4.4 (trigger model / dispatch),
// §4.5 layer 3 (pid sweep), §4.6 (dependency cascade), §4.9 (session vs
// resume); CLAUDE.md hard constraints.
//
// The wake loop. Single-threaded by construction: pollOnce is only ever
// awaited in sequence by watchLoop, so "at most one manager process alive"
// (spec §4.4) falls out of never starting a second turn before the first
// one's await resolves — no lock needed.
//
// pollOnce runs four ordered steps (spec §4.4):
//   1. SWEEP    — assigned rows whose pid is gone -> failed (delivered=0)
//   2. CASCADE  — rows whose dep is terminal-but-not-done -> cancelled (delivered=1)
//   3. DISPATCH — every ready row, up to --max-workers cap -> claimSubtask
//   4. WAKE     — if any undelivered debt, run one manager turn; deliver
//                 the batch (one transaction) only after the turn completes
//
// A manager turn is injected as a function, not hardcoded to `claude -p`:
// Phase 3 uses tests/fakes/policy-manager.ts. Phase 5 swaps the function.

import { Database } from "bun:sqlite";
import { tx } from "./db";
import { cancelSubtask, failSubtask } from "./subtasks";
import {
  cascadeCandidates,
  readySubtasks,
  assignedCount,
  liveWorkerOnWorktree,
  nextDebtBatch,
} from "./queries";
import { resolveWorktreePath } from "./subtasks";

export interface ManagerTurnArgs {
  runId: number;
  sessionId: string;
  isFirstTurn: boolean;
  batch: DebtBatch;
}

export type ManagerTurnFn = (args: ManagerTurnArgs) => Promise<void>;

// Injected by the watcher to actually spawn a ready row.
export type DispatchFn = (subtaskId: number) => void;

export interface DebtBatch {
  kind: "messages" | "task" | "none";
  taskId: number | null;
  subtaskIds: number[];
  messageIds: number[];
}

function nowIso(): string {
  return new Date().toISOString();
}

interface RunRow {
  id: number;
  status: string;
  manager_session_id: string;
  manager_turns: number;
}

function getRun(db: Database, runId: number): RunRow {
  const row = db.query("SELECT id, status, manager_session_id, manager_turns FROM runs WHERE id = ?").get(runId) as RunRow | null;
  if (!row) throw new Error(`watcher: no run ${runId}`);
  return row;
}

// spec §4.5 layer 3: any row with stage='assigned' whose worker_pid is gone
// -> failed (delivered=0; failure is judgment, §4.2).
// process.kill(pid, 0) throws ESRCH if the process is dead.
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code !== "ESRCH" ? true : false;
  }
}

export function pidSweep(db: Database, runId: number): number[] {
  const assigned = db
    .query("SELECT id, worker_pid FROM subtasks WHERE run_id = ? AND stage = 'assigned'")
    .all(runId) as Array<{ id: number; worker_pid: number | null }>;

  const swept: number[] = [];
  for (const row of assigned) {
    if (row.worker_pid === null || !isPidAlive(row.worker_pid)) {
      // Re-check current stage before writing — a reply may have landed
      // between the SELECT above and now. failSubtask opens its own
      // BEGIN IMMEDIATE transaction, so we do NOT wrap here.
      const current = db.query("SELECT stage FROM subtasks WHERE id = ?").get(row.id) as
        | { stage: string }
        | null;
      if (current && current.stage === "assigned") {
        try {
          // failSubtask writes delivered=0 (§4.5: failure is judgment, §4.2)
          failSubtask(db, row.id, "pid sweep: worker process gone, no reply landed");
          swept.push(row.id);
        } catch {
          // Lost the race to a concurrent reply — not an error.
        }
      }
    }
  }
  return swept;
}

// spec §4.6 source 3: a row whose dep ended failed/cancelled can never
// become ready. Mechanical; cancelSubtask writes delivered=1 (§4.2).
export function cascadeCancel(db: Database, runId: number): number[] {
  const cancelled: number[] = [];
  while (true) {
    const candidates = cascadeCandidates(db, runId);
    if (candidates.length === 0) break;
    let progressed = false;
    for (const row of candidates) {
      const deps: number[] = JSON.parse(row.depends_on);
      const failedDep = deps.find((depId) => {
        const dep = db.query("SELECT stage FROM subtasks WHERE id = ?").get(depId) as
          | { stage: string }
          | null;
        return dep && (dep.stage === "failed" || dep.stage === "cancelled");
      });
      if (failedDep === undefined) continue;
      try {
        cancelSubtask(db, row.id, `dependency ${failedDep} failed`);
        cancelled.push(row.id);
        progressed = true;
      } catch {
        // Already terminal — raced by something else; not an error.
      }
    }
    if (!progressed) break;
  }
  return cancelled;
}

// spec §4.4 step 3: dispatch every ready row up to the concurrency cap.
// Rows dispatched in ascending id order ("ties break by id", §4.4).
// Worktree collision: leave row unassigned, write a NOTE, retry next poll.
export function dispatchReady(
  db: Database,
  runId: number,
  repoRoot: string,
  maxWorkers: number,
  dispatchFn: DispatchFn
): number[] {
  const dispatched: number[] = [];

  const ready = readySubtasks(db, runId); // already ordered by id
  for (const subtask of ready) {
    const current = assignedCount(db, runId);
    if (current >= maxWorkers) break;

    let worktreePath: string;
    try {
      worktreePath = resolveWorktreePath(db, subtask.id, repoRoot);
    } catch (e) {
      writeNote(db, runId, `dispatch: could not resolve worktree for subtask ${subtask.id}: ${e}`);
      continue;
    }

    const conflictId = liveWorkerOnWorktree(db, runId, worktreePath);
    if (conflictId !== null) {
      writeNote(
        db,
        runId,
        `dispatch: subtask ${subtask.id} shares worktree "${worktreePath}" with live worker on subtask ${conflictId}; left unassigned — add a depends_on edge to resolve`
      );
      continue;
    }

    dispatchFn(subtask.id);
    dispatched.push(subtask.id);
  }

  return dispatched;
}

// spec §4.2 health check: advisory NOTE for rows that are terminal,
// delivered=1, and verdict IS NULL. Written after deliverBatch so it
// catches exactly the rows that were just delivered without a verdict.
// Advisory only — does not gate or re-trigger anything.
function writeSkippedRowNote(db: Database, runId: number): void {
  const skipped = db
    .query(
      `SELECT id FROM subtasks
       WHERE run_id = ? AND delivered = 1 AND verdict IS NULL
         AND stage IN ('done', 'failed', 'cancelled')`
    )
    .all(runId) as Array<{ id: number }>;
  if (skipped.length === 0) return;
  const ids = skipped.map((r) => r.id).join(", ");
  writeNote(db, runId, `health: subtasks delivered without verdict: ${ids}`);
}

function writeNote(db: Database, runId: number, body: string): void {
  tx(db, () => {
    db.query(
      `INSERT INTO messages (run_id, author, type, body, delivered, created_at)
       VALUES (?, 'manager', 'NOTE', ?, 0, ?)`
    ).run(runId, body, nowIso());
  });
}

// spec §4.2: mark the whole batch delivered in one transaction, only after
// the turn completes. A turn that dies mid-way delivers nothing.
function deliverBatch(db: Database, batch: DebtBatch): void {
  tx(db, () => {
    for (const id of batch.subtaskIds) {
      db.query("UPDATE subtasks SET delivered = 1 WHERE id = ?").run(id);
    }
    for (const id of batch.messageIds) {
      db.query("UPDATE messages SET delivered = 1 WHERE id = ?").run(id);
    }
  });
}

function markTurnComplete(db: Database, runId: number): void {
  tx(db, () => {
    db.query("UPDATE runs SET manager_turns = manager_turns + 1 WHERE id = ?").run(runId);
  });
}

export interface PollResult {
  swept: number[];
  cascadeCancelled: number[];
  dispatched: number[];
  wokeManager: boolean;
  batch: DebtBatch;
}

export interface PollOptions {
  maxWorkers?: number;
  repoRoot?: string;
  // Override for tests: instead of calling claimSubtask, call this.
  dispatchFn?: DispatchFn;
}

// spec §4.4: one poll cycle. Four ordered steps: sweep, cascade, dispatch,
// wake. Step 4 (wake) stays awaited — keeps mutual exclusion structural.
// Step 3 (dispatch) is non-blocking via claimSubtask.
//
// Delivery: the batch is selected before the turn runs. If the turn
// completes, delivered=1 is written across the batch in one transaction.
// If the turn throws, delivered stays 0 and the batch is carried again
// (same guarantee as manager_turns: a failed turn leaves the counter alone).
export async function pollOnce(
  db: Database,
  runId: number,
  runManagerTurn: ManagerTurnFn,
  opts: PollOptions = {}
): Promise<PollResult> {
  const maxWorkers = opts.maxWorkers ?? 1;
  const repoRoot = opts.repoRoot ?? process.cwd();

  // Step 1: SWEEP
  const swept = pidSweep(db, runId);

  // Step 2: CASCADE
  const cascadeCancelled = cascadeCancel(db, runId);

  // Step 3: DISPATCH
  const dispatchFn: DispatchFn =
    opts.dispatchFn ??
    ((_subtaskId) => {
      // No dispatchFn injected — dispatch silently skipped. The CLI always
      // injects one; if this fires in a test, inject opts.dispatchFn.
    });

  const dispatched = dispatchReady(db, runId, repoRoot, maxWorkers, dispatchFn);

  // Step 4: WAKE — scan for undelivered debt (spec §4.2).
  const debtBatch = nextDebtBatch(db, runId);
  const emptyBatch: DebtBatch = { kind: "none", taskId: null, subtaskIds: [], messageIds: [] };

  if (!debtBatch) {
    return { swept, cascadeCancelled, dispatched, wokeManager: false, batch: emptyBatch };
  }

  const run = getRun(db, runId);
  const isFirstTurn = run.manager_turns === 0;

  // Run the turn. If it throws, deliver nothing and let the next poll retry.
  await runManagerTurn({ runId, sessionId: run.manager_session_id, isFirstTurn, batch: debtBatch });

  // Turn completed — increment manager_turns then deliver the whole batch
  // in one transaction (§4.2: one transaction, after the turn, never per row).
  markTurnComplete(db, runId);
  deliverBatch(db, debtBatch);

  // spec §4.2 health check: rows that are terminal, delivered=1, and
  // verdict IS NULL after delivery are probably ones the manager skimmed
  // past. Write one advisory NOTE naming them. Does not gate or re-trigger.
  writeSkippedRowNote(db, runId);

  return { swept, cascadeCancelled, dispatched, wokeManager: true, batch: debtBatch };
}

export interface WatchOptions {
  intervalMs?: number;
  signal?: AbortSignal;
  maxWorkers?: number;
  repoRoot?: string;
  dispatchFn?: DispatchFn;
}

// spec §4.10: watcher poll interval 2s. Attaches to an existing run.
// Loop body awaits pollOnce fully before sleeping.
export async function watchLoop(
  db: Database,
  runId: number,
  runManagerTurn: ManagerTurnFn,
  opts: WatchOptions = {}
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 2000;
  const pollOpts: PollOptions = {
    maxWorkers: opts.maxWorkers ?? 1,
    repoRoot: opts.repoRoot,
    dispatchFn: opts.dispatchFn,
  };
  while (!opts.signal?.aborted) {
    await pollOnce(db, runId, runManagerTurn, pollOpts);
    const run = getRun(db, runId);
    if (run.status !== "running") return;
    await Bun.sleep(intervalMs);
  }
}
