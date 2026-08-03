// spec §2.1, §2.2, §2.3, §2.4, §4.1, §4.2, §4.6
//
// Row lifecycle WRITES. Every subtask stage write lives in this file —
// one file to audit for the BEGIN IMMEDIATE rule (CLAUDE.md).
//
// delivered is written ONLY by the watcher (spec §4.2) — never here,
// except for the three cancellation sources which are born delivered=1
// (§4.2 "writes that are born delivered"). failSubtask is explicitly NOT
// born delivered — the response to a failure is judgment, not mechanical.
//
// verdictSubtask writes verdict only. It does not touch delivered — the
// manager has no bookkeeping verb (spec §4.2, §7 "no ack verb").

import { Database } from "bun:sqlite";
import { tx } from "./db";

function nowIso(): string {
  return new Date().toISOString();
}

export interface InitResult {
  runId: number;
  managerSessionId: string;
  messageId: number;
  taskId: number;
}

// spec §4.1 `synapse init`: create runs row, generate manager_session_id
// (unused — no session exists yet), create the first REQUEST message +
// its tasks row. Starts nothing. The REQUEST is operator-authored so it
// is born delivered=0 (spec §4.2: operator messages need a manager reaction).
export function initRun(db: Database, goalText: string): InitResult {
  return tx(db, () => {
    const managerSessionId = crypto.randomUUID();
    const now = nowIso();

    const runRow = db
      .query(
        `INSERT INTO runs (status, manager_session_id, manager_turns, created_at)
         VALUES ('running', ?, 0, ?)
         RETURNING id`
      )
      .get(managerSessionId, now) as { id: number };
    const runId = runRow.id;

    const msgRow = db
      .query(
        `INSERT INTO messages (run_id, author, type, ref_id, body, title, options, delivered, created_at)
         VALUES (?, 'operator', 'REQUEST', NULL, ?, NULL, NULL, 0, ?)
         RETURNING id`
      )
      .get(runId, goalText, now) as { id: number };
    const messageId = msgRow.id;

    const taskRow = db
      .query(
        `INSERT INTO tasks (run_id, text, status, source_message_id, created_at)
         VALUES (?, ?, 'open', ?, ?)
         RETURNING id`
      )
      .get(runId, goalText, messageId, now) as { id: number };
    const taskId = taskRow.id;

    return { runId, managerSessionId, messageId, taskId };
  });
}

export interface CreateSubtaskArgs {
  runId: number;
  taskId: number;
  title: string;
  assigneeRole: string;
  dependsOn: number[];
}

// spec §5 `synapse task`: the manager creates a subtask row. No delivered
// write — row creation is a manager write and carries no delivery obligation
// (§4.2: dispatch creates no debt either).
export function createSubtask(db: Database, args: CreateSubtaskArgs): number {
  return tx(db, () => {
    const now = nowIso();
    const row = db
      .query(
        `INSERT INTO subtasks (run_id, task_id, title, assignee_role, depends_on, stage, delivered, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'unassigned', 0, ?, ?)
         RETURNING id`
      )
      .get(
        args.runId,
        args.taskId,
        args.title,
        args.assigneeRole,
        JSON.stringify(args.dependsOn),
        now,
        now
      ) as { id: number };
    return row.id;
  });
}

// spec §4.7: no deps -> repo root (Tier 1); has deps -> inherit the
// worktree of the first dep (its subject). Writes worktree_path at dispatch.
export function resolveWorktreePath(db: Database, subtaskId: number, repoRoot: string): string {
  return tx(db, () => {
    const row = db.query("SELECT depends_on FROM subtasks WHERE id = ?").get(subtaskId) as
      | { depends_on: string }
      | null;
    if (!row) throw new Error(`resolveWorktreePath: no subtask ${subtaskId}`);
    const deps: number[] = JSON.parse(row.depends_on);

    let path = repoRoot;
    if (deps.length > 0) {
      const subject = db.query("SELECT worktree_path FROM subtasks WHERE id = ?").get(deps[0]) as
        | { worktree_path: string | null }
        | null;
      if (!subject) throw new Error(`resolveWorktreePath: subject ${deps[0]} not found`);
      if (!subject.worktree_path) {
        throw new Error(
          `resolveWorktreePath: subject ${deps[0]} has no worktree_path yet`
        );
      }
      path = subject.worktree_path;
    }

    db.query("UPDATE subtasks SET worktree_path = ? WHERE id = ?").run(path, subtaskId);
    return path;
  });
}

export class SubtaskTerminalError extends Error {}

// spec §4.6, §4.2: reply against any terminal row is rejected.
// Worker write, stage -> done. delivered stays 0 — the watcher writes it
// after the manager turn that carries this row completes (§4.2).
export function replySubtask(
  db: Database,
  subtaskId: number,
  resultSummary: string,
  artifactPath: string | null
): void {
  tx(db, () => {
    const row = db.query("SELECT stage FROM subtasks WHERE id = ?").get(subtaskId) as
      | { stage: string }
      | null;
    if (!row) throw new Error(`replySubtask: no subtask ${subtaskId}`);
    if (row.stage === "cancelled" || row.stage === "failed" || row.stage === "done") {
      throw new SubtaskTerminalError(
        `subtask ${subtaskId} is already ${row.stage}; reply rejected`
      );
    }
    const now = nowIso();
    db.query(
      `UPDATE subtasks
       SET stage = 'done', result_summary = ?, artifact_path = ?, delivered = 0, updated_at = ?
       WHERE id = ?`
    ).run(resultSummary, artifactPath, now, subtaskId);
  });
}

// spec §4.5: wrapper/sweep failure write, stage -> failed.
// delivered stays 0 — failure is judgment, not mechanical (§4.2: "failed
// is never born delivered").
export function failSubtask(db: Database, subtaskId: number, resultSummary: string): void {
  tx(db, () => {
    const row = db.query("SELECT stage FROM subtasks WHERE id = ?").get(subtaskId) as
      | { stage: string }
      | null;
    if (!row) throw new Error(`failSubtask: no subtask ${subtaskId}`);
    if (row.stage === "cancelled" || row.stage === "failed" || row.stage === "done") {
      throw new SubtaskTerminalError(
        `subtask ${subtaskId} is already ${row.stage}; fail rejected`
      );
    }
    const now = nowIso();
    db.query(
      `UPDATE subtasks SET stage = 'failed', result_summary = ?, delivered = 0, updated_at = ? WHERE id = ?`
    ).run(resultSummary, now, subtaskId);
  });
}

// spec §4.6, §4.2: cancel write, stage -> cancelled. All three cancellation
// sources (operator task cancel, manager cancel, cascade) are born
// delivered=1 — the decision is already made, nothing for the manager to
// judge (§4.2 "writes that are born delivered").
export function cancelSubtask(db: Database, subtaskId: number, cancelReason: string): void {
  tx(db, () => {
    const row = db.query("SELECT stage FROM subtasks WHERE id = ?").get(subtaskId) as
      | { stage: string }
      | null;
    if (!row) throw new Error(`cancelSubtask: no subtask ${subtaskId}`);
    if (row.stage === "done" || row.stage === "failed" || row.stage === "cancelled") {
      throw new SubtaskTerminalError(
        `subtask ${subtaskId} is already ${row.stage}; cancel rejected`
      );
    }
    const now = nowIso();
    db.query(
      `UPDATE subtasks
       SET stage = 'cancelled', cancel_reason = ?, cancelled_at = ?, delivered = 1, updated_at = ?
       WHERE id = ?`
    ).run(cancelReason, now, now, subtaskId);
  });
}

// spec §5 `synapse verdict`, §4.2: the manager's ruling on a terminal row.
// Writes verdict only — does NOT touch delivered (the manager has no
// bookkeeping verb; §7 "no ack verb").
export function verdictSubtask(db: Database, subtaskId: number, ruling: string): void {
  tx(db, () => {
    const row = db.query("SELECT stage FROM subtasks WHERE id = ?").get(subtaskId) as
      | { stage: string }
      | null;
    if (!row) throw new Error(`verdictSubtask: no subtask ${subtaskId}`);
    db.query("UPDATE subtasks SET verdict = ? WHERE id = ?").run(ruling, subtaskId);
  });
}

// spec §4.6: synapse done closes the run once every task is work_closed or
// cancelled. Gates on task_progress (queries.ts), never on stored status.
export function closeRun(db: Database, runId: number): void {
  tx(db, () => {
    const now = nowIso();
    db.query("UPDATE runs SET status = 'done', ended_at = ? WHERE id = ?").run(now, runId);
  });
}
