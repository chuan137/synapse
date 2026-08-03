// spec §2.2, §2.3.1, §4.3, §4.4, §5
//
// Derived READS only. This file never writes. Readiness is a single SQL
// query using json_each over depends_on — not rows pulled into TS and
// filtered — so it stays recomputable from the tables alone after a
// context compaction (spec §4.3, CLAUDE.md).

import { Database } from "bun:sqlite";

// spec §4.3: a row is ready when stage='unassigned' and every id in
// depends_on has stage='done'. A row with depends_on=[] is ready
// immediately (the NOT EXISTS is vacuously true).
const READY_SQL = `
  SELECT s.*
  FROM subtasks s
  WHERE s.stage = 'unassigned'
    AND NOT EXISTS (
      SELECT 1
      FROM json_each(s.depends_on) dep
      JOIN subtasks d ON d.id = dep.value
      WHERE d.stage != 'done'
    )
`;

export function readySubtasks(db: Database, runId: number): any[] {
  return db
    .query(`${READY_SQL} AND s.run_id = ? ORDER BY s.id`)
    .all(runId);
}

export function isSubtaskReady(db: Database, subtaskId: number): boolean {
  const row = db
    .query(`SELECT 1 AS ready FROM (${READY_SQL}) WHERE id = ?`)
    .get(subtaskId);
  return row !== null;
}

// spec §4.6: a row whose dep ended failed/cancelled can never become
// ready — a cascade candidate. Detection is a derived read; the cancel
// itself is a write in subtasks.ts (cancelSubtask).
const CASCADE_CANDIDATE_SQL = `
  SELECT s.*
  FROM subtasks s
  WHERE s.stage IN ('unassigned', 'assigned')
    AND EXISTS (
      SELECT 1
      FROM json_each(s.depends_on) dep
      JOIN subtasks d ON d.id = dep.value
      WHERE d.stage IN ('failed', 'cancelled')
    )
`;

export function cascadeCandidates(db: Database, runId: number): any[] {
  return db
    .query(`${CASCADE_CANDIDATE_SQL} AND s.run_id = ? ORDER BY s.id`)
    .all(runId);
}

export interface TaskProgressRow {
  id: number;
  run_id: number;
  status: string;
  n_subtasks: number;
  n_terminal: number;
  work_settled: number; // sqlite boolean: 0 | 1
}

export function taskProgress(db: Database, taskId: number): TaskProgressRow {
  const row = db.query("SELECT * FROM task_progress WHERE id = ?").get(taskId) as
    | TaskProgressRow
    | null;
  if (!row) throw new Error(`taskProgress: no task ${taskId}`);
  return row;
}

export function taskProgressForRun(db: Database, runId: number): TaskProgressRow[] {
  return db
    .query("SELECT * FROM task_progress WHERE run_id = ? ORDER BY id")
    .all(runId) as TaskProgressRow[];
}

// spec §4.6, §2.2: a run may close when every task is terminal —
// work_settled and tasks.status='done', or tasks.status='cancelled' —
// never on stored status alone (except the explicit cancelled escape).
export function runIsDone(db: Database, runId: number): boolean {
  const rows = taskProgressForRun(db, runId);
  if (rows.length === 0) return false;
  return rows.every((r) => r.status === "cancelled" || (r.work_settled === 1 && r.status === "done"));
}

// spec §4.4: count of rows currently assigned for this run — used by the
// watcher to enforce --max-workers. Queried from the table, not watcher
// memory, so a restarted watcher re-derives it (principle 1).
export function assignedCount(db: Database, runId: number): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM subtasks WHERE run_id = ? AND stage = 'assigned'")
    .get(runId) as { n: number };
  return row.n;
}

// spec §4.4: for worktree-collision detection. Returns the id of a live
// (stage=assigned) row whose worktree_path matches the given path, or null
// if no such row exists. "Live" means assigned — a row that has committed
// done but not yet exited is not counted (§4.10: the cap counts assigned
// rows, so the overlap is possible and the graph rule handles it).
export function liveWorkerOnWorktree(
  db: Database,
  runId: number,
  worktreePath: string
): number | null {
  const row = db
    .query(
      "SELECT id FROM subtasks WHERE run_id = ? AND stage = 'assigned' AND worktree_path = ? LIMIT 1"
    )
    .get(runId, worktreePath) as { id: number } | null;
  return row ? row.id : null;
}

export interface StatusView {
  run: any;
  tasks: Array<{
    task: any;
    progress: TaskProgressRow;
    subtasks: any[];
  }>;
}

// spec §5 `synapse status`: run -> tasks -> subtasks, with deps and
// readiness. The one read verb (D6); --json is the manager's machine
// read, without it is the operator's human render (handled in cli.ts).
export function statusView(db: Database, runId: number): StatusView {
  const run = db.query("SELECT * FROM runs WHERE id = ?").get(runId);
  if (!run) throw new Error(`statusView: no run ${runId}`);

  const tasks = db.query("SELECT * FROM tasks WHERE run_id = ? ORDER BY id").all(runId) as any[];
  const readyIds = new Set(readySubtasks(db, runId).map((s: any) => s.id));

  const taskViews = tasks.map((task) => {
    const subtasks = db
      .query("SELECT * FROM subtasks WHERE task_id = ? ORDER BY id")
      .all(task.id) as any[];
    const decorated = subtasks.map((s) => ({ ...s, ready: readyIds.has(s.id) }));
    return {
      task,
      progress: taskProgress(db, task.id),
      subtasks: decorated,
    };
  });

  return { run, tasks: taskViews };
}
