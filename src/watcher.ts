// spec §4.2 (rev ordering), §4.4 (trigger model), §4.5 layer 3 (pid sweep),
// §4.6 (dependency cascade), §4.9 (session vs resume); CLAUDE.md hard
// constraints (rev owed only to writes the manager owes a reaction to,
// readiness/cascade computed in SQL)
//
// The wake loop. Single-threaded by construction: pollOnce is only ever
// awaited in sequence by watchLoop, so "at most one manager process alive"
// (spec §4.4) falls out of never starting a second turn before the first
// one's await resolves — no lock needed.
//
// A manager turn is injected as a function, not hardcoded to `claude -p`:
// Phase 3 has no real model, only tests/fakes/policy-manager.ts. Phase 5
// swaps the function, not this file.

import { Database } from "bun:sqlite";
import { tx } from "./db";
import { cancelSubtask } from "./subtasks";
import { cascadeCandidates } from "./queries";

export interface ManagerTurnArgs {
  runId: number;
  sessionId: string;
  isFirstTurn: boolean;
}

export type ManagerTurnFn = (args: ManagerTurnArgs) => Promise<void>;

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
// -> failed. process.kill(pid, 0) throws ESRCH if the process is dead;
// costs one column, no state kept between polls.
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
        // Re-check inside the transaction: a reply may have landed between
        // the SELECT above and this write.
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
// become ready. Mechanical, no manager judgment. cascadeCandidates
// (queries.ts) is the derived read; this is the write.
export function cascadeCancel(db: Database, runId: number): number[] {
  const cancelled: number[] = [];
  // Cascades can chain (a cancelled row can itself be a dep of another
  // row), so loop until a pass finds nothing new.
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
        // Already terminal by the time we got here (raced by something
        // else) — nothing to do, not an error.
      }
    }
    if (!progressed) break;
  }
  return cancelled;
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
  wokeManager: boolean;
}

// spec §4.2, §4.4: one poll cycle. Sweep and cascade run every poll
// regardless of rev (they are mechanical, not manager judgment). The
// manager wakes only if it owes a reaction: rev_seen is read BEFORE the
// turn and manager_reacted_rev is written AFTER, so anything landing
// mid-turn has rev > rev_seen and is caught on the next poll (spec §4.2's
// mid-turn-loss fix). runManagerTurn is awaited to completion before this
// function returns, which is what makes "at most one manager process
// alive" structural rather than lock-enforced.
export async function pollOnce(
  db: Database,
  runId: number,
  runManagerTurn: ManagerTurnFn
): Promise<PollResult> {
  const swept = pidSweep(db, runId);
  const cascadeCancelled = cascadeCancel(db, runId);

  const run = getRun(db, runId);
  const revSeen = maxRev(db, runId);

  if (revSeen <= run.manager_reacted_rev) {
    return { swept, cascadeCancelled, wokeManager: false };
  }

  const isFirstTurn = run.manager_turns === 0;
  await runManagerTurn({ runId, sessionId: run.manager_session_id, isFirstTurn });
  markTurnComplete(db, runId);
  setReactedRev(db, runId, revSeen);

  return { swept, cascadeCancelled, wokeManager: true };
}

export interface WatchOptions {
  intervalMs?: number;
  signal?: AbortSignal;
}

// spec §4.10: watcher poll interval 2s. Attaches to an existing run —
// synapse init creates the run and spawns nothing (spec §4.1); this is the
// only thing that starts manager turns (spec §4.4). Loop body awaits
// pollOnce fully before sleeping, so restart-after-kill is just calling
// this again: nothing but the tables carries state between watcher lives.
export async function watchLoop(
  db: Database,
  runId: number,
  runManagerTurn: ManagerTurnFn,
  opts: WatchOptions = {}
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 2000;
  while (!opts.signal?.aborted) {
    await pollOnce(db, runId, runManagerTurn);
    const run = getRun(db, runId);
    if (run.status !== "running") return;
    await Bun.sleep(intervalMs);
  }
}
