// plan Phase 3: "a deterministic stand-in: reads the tables, writes
// verdicts, dispatches every ready row. It does what a manager does, minus
// judgment." Used as the ManagerTurnFn injected into watcher.ts's
// pollOnce/watchLoop so Phase 3's exit criteria run with zero model calls.
//
// No rev is assigned by any of this (spec §4.2: manager writes never take
// a rev, or the manager would wake itself in a loop) — verdicts go through
// a raw UPDATE, not through subtasks.ts's rev-assigning writes.

import { Database } from "bun:sqlite";
import { readySubtasks } from "../../src/queries";
import { spawnSubtask } from "../../src/spawn";
import type { ManagerTurnFn } from "../../src/watcher";

export interface PolicyManagerOptions {
  synapseBin: string;
  cwd: string;
  fakeCommandFor?: (subtask: any) => string[];
}

const DEFAULT_FAKE = "good.sh";

function defaultCommandFor(): string[] {
  return [`${import.meta.dir}/${DEFAULT_FAKE}`];
}

// Judges every subtask that is newly terminal (done/failed/cancelled) and
// not yet judged (verdict IS NULL). A manager write — no rev.
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

// Dispatches every ready row (spec §4.3: stage=unassigned, all deps done).
async function dispatchReadyRows(
  db: Database,
  runId: number,
  opts: PolicyManagerOptions
): Promise<void> {
  const ready = readySubtasks(db, runId);
  const commandFor = opts.fakeCommandFor ?? defaultCommandFor;
  for (const subtask of ready) {
    await spawnSubtask(db, {
      subtaskId: subtask.id,
      command: commandFor(subtask),
      synapseBin: opts.synapseBin,
      cwd: opts.cwd,
    });
  }
}

// Returns a ManagerTurnFn (src/watcher.ts's injectable turn function).
export function makePolicyManager(db: Database, opts: PolicyManagerOptions): ManagerTurnFn {
  return async ({ runId }) => {
    judgeTerminalRows(db, runId);
    await dispatchReadyRows(db, runId, opts);
  };
}
