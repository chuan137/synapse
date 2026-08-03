// spec §4.2 (rev ordering / wake condition), §4.4 (trigger model / dispatch),
// §4.5 layer 3 (pid sweep), §4.6 (dependency cascade), §4.9 (session vs
// resume); CLAUDE.md hard constraints.
//
// The wake loop. Single-threaded by construction: pollOnce is only ever
// awaited in sequence by watchLoop, so "at most one manager process alive"
// (spec §4.4) falls out of never starting a second turn before the first
// one's await resolves — no lock needed.
//
// pollOnce runs four ordered steps (spec §4.4):
//   1. SWEEP    — assigned rows whose pid is gone -> failed
//   2. CASCADE  — rows whose dep is terminal-but-not-done -> cancelled
//   3. DISPATCH — every ready row, up to --max-workers cap -> claimSubtask
//   4. WAKE     — if outstanding debt, run one manager turn
//
// A manager turn is injected as a function, not hardcoded to `claude -p`:
// Phase 3 uses tests/fakes/policy-manager.ts. Phase 5 swaps the function.

import { Database } from "bun:sqlite";
import { tx } from "./db";
import { cancelSubtask } from "./subtasks";
import { cascadeCandidates, readySubtasks, assignedCount, liveWorkerOnWorktree } from "./queries";
import { resolveWorktreePath } from "./subtasks";

export interface ManagerTurnArgs {
  runId: number;
  sessionId: string;
  isFirstTurn: boolean;
}

export type ManagerTurnFn = (args: ManagerTurnArgs) => Promise<void>;

// Injected by the watcher to actually spawn a ready row. The watcher
// provides the real claimSubtask; tests can override (e.g. policy-manager).
export type DispatchFn = (subtaskId: number) => void;

function nowIso(): string {
  return new Date().toISOString();
}

interface RunRow {
  id: number;
  status: string;
  manager_session_id: string;
  rev_counter: number;
  manager_reacted_rev: number;
  manager_turns: number;
}

function getRun(db: Database, runId: number): RunRow {
  const row = db.query("SELECT * FROM runs WHERE id = ?").get(runId) as RunRow | null;
  if (!row) throw new Error(`watcher: no run ${runId}`);
  return row;
}

// spec §4.5 layer 3: any row with stage='assigned' whose worker_pid is gone
// -> failed. process.kill(pid, 0) throws ESRCH if the process is dead.
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
      tx(db, () => {
        const current = db.query("SELECT stage FROM subtasks WHERE id = ?").get(row.id) as
          | { stage: string }
          | null;
        if (current && current.stage === "assigned") {
          const rev = bumpRev(db, runId);
          db.query(
            `UPDATE subtasks SET stage = 'failed', result_summary = ?, rev = ?, updated_at = ? WHERE id = ?`
          ).run("pid sweep: worker process gone, no reply landed", rev, nowIso(), row.id);
          swept.push(row.id);
        }
      });
    }
  }
  return swept;
}

function bumpRev(db: Database, runId: number): number {
  const row = db
    .query("UPDATE runs SET rev_counter = rev_counter + 1 WHERE id = ? RETURNING rev_counter")
    .get(runId) as { rev_counter: number };
  return row.rev_counter;
}

// spec §4.6 source 3: a row whose dep ended failed/cancelled can never
// become ready. Mechanical, no manager judgment. cascadeCandidates is the
// derived read; this is the write.
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
// Rows are dispatched in ascending id order (spec §4.4: "ties break by
// id"). Returns ids that were claimed this poll.
//
// Worktree collision: if a ready row's resolved worktree_path already holds
// a live (assigned) worker, the row is left unassigned and a NOTE is written
// naming both rows. Do not queue — the collision means a missing ordering
// edge, which should be a signal (spec §4.4). The row is retried next poll.
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

    // Resolve worktree path (writes worktree_path on the row).
    let worktreePath: string;
    try {
      worktreePath = resolveWorktreePath(db, subtask.id, repoRoot);
    } catch (e) {
      // Subject row has no worktree_path yet — shouldn't happen if subject
      // is done (readiness requires deps=done), but guard defensively.
      writeNote(db, runId, `dispatch: could not resolve worktree for subtask ${subtask.id}: ${e}`);
      continue;
    }

    // Collision check (§4.4).
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

function writeNote(db: Database, runId: number, body: string): void {
  tx(db, () => {
    db.query(
      `INSERT INTO messages (run_id, author, type, body, created_at)
       VALUES (?, 'manager', 'NOTE', ?, ?)`
    ).run(runId, body, nowIso());
  });
}

function maxRev(db: Database, runId: number): number {
  const row = db
    .query(
      `SELECT MAX(rev) AS m FROM (
         SELECT rev FROM subtasks WHERE run_id = ? AND rev IS NOT NULL
         UNION ALL
         SELECT rev FROM messages WHERE run_id = ? AND rev IS NOT NULL
       )`
    )
    .get(runId, runId) as { m: number | null };
  return row.m ?? 0;
}

function setReactedRev(db: Database, runId: number, rev: number): void {
  tx(db, () => {
    db.query("UPDATE runs SET manager_reacted_rev = ? WHERE id = ?").run(rev, runId);
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
}

export interface PollOptions {
  maxWorkers?: number;
  repoRoot?: string;
  // Override for tests: instead of calling claimSubtask, call this.
  dispatchFn?: DispatchFn;
}

// spec §4.4: one poll cycle. Four ordered steps: sweep, cascade, dispatch,
// wake. Step 4 (wake) stays awaited — keeps mutual exclusion structural.
// Step 3 (dispatch) is non-blocking via claimSubtask (Q1).
//
// rev_seen is read BEFORE the turn; manager_reacted_rev is written AFTER,
// so anything landing mid-turn has rev > rev_seen and is caught next poll.
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
  // dispatchFn must be injected by the caller (cmdWatch in cli.ts builds it
  // from roles.ts; tests inject a fake-worker spawner). There is no sensible
  // default — the command depends on the role and model, which only the CLI
  // layer knows. Omitting it means no workers are spawned this poll (safe for
  // wake-only polls in tests that don't exercise dispatch).
  const dispatchFn: DispatchFn =
    opts.dispatchFn ??
    ((_subtaskId) => {
      // No dispatchFn injected — dispatch silently skipped. The CLI always
      // injects one; if this fires in a test, inject opts.dispatchFn.
    });

  const dispatched = dispatchReady(db, runId, repoRoot, maxWorkers, dispatchFn);

  // Step 4: WAKE
  const run = getRun(db, runId);
  const revSeen = maxRev(db, runId);

  if (revSeen <= run.manager_reacted_rev) {
    return { swept, cascadeCancelled, dispatched, wokeManager: false };
  }

  const isFirstTurn = run.manager_turns === 0;
  await runManagerTurn({ runId, sessionId: run.manager_session_id, isFirstTurn });
  markTurnComplete(db, runId);
  setReactedRev(db, runId, revSeen);

  return { swept, cascadeCancelled, dispatched, wokeManager: true };
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
