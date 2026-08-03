// plan Phase 3 / Phase 4.5 refactor: dispatch moves from the manager to the
// watcher (spec §4.3, §4.4). This stand-in now only judges — the watcher's
// dispatchReady step runs before the manager turn is called.
//
// No rev is assigned by any of this (spec §4.2: manager writes never take
// a rev, or the manager would wake itself in a loop) — verdicts go through
// a raw UPDATE, not through subtasks.ts's rev-assigning writes.

import { Database } from "bun:sqlite";
import type { ManagerTurnFn } from "../../src/watcher";

export interface PolicyManagerOptions {
  synapseBin: string;
  cwd: string;
}

// Judges every subtask that is terminal and not yet judged (verdict IS NULL).
// A manager write — no rev.
function judgeTerminalRows(db: Database, runId: number): void {
  const rows = db
    .query(
      `SELECT id, stage FROM subtasks
       WHERE run_id = ? AND stage IN ('done', 'failed', 'cancelled') AND verdict IS NULL`
    )
    .all(runId) as Array<{ id: number; stage: string }>;
  for (const row of rows) {
    const verdict = row.stage === "done" ? "LGTM" : `issues: subtask ended ${row.stage}`;
    db.query("UPDATE subtasks SET verdict = ? WHERE id = ?").run(verdict, row.id);
  }
}

// Returns a ManagerTurnFn. Dispatch is the watcher's job now; this only judges.
export function makePolicyManager(db: Database, _opts: PolicyManagerOptions): ManagerTurnFn {
  return async ({ runId }) => {
    judgeTerminalRows(db, runId);
  };
}
