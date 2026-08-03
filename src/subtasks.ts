// spec §2.1, §2.2, §2.3, §2.4, §4.1, §4.2, §4.6
//
// Row lifecycle WRITES. Every rev-assigning write lives in this file — one
// file to audit for the BEGIN IMMEDIATE and rev-assignment rules
// (CLAUDE.md). A rev is assigned only by writes the manager owes a
// reaction to: worker reply, failure, cancel-cascade, operator-authored
// messages. Never by manager writes (verdicts, row creation, dispatch,
// task status) — otherwise the manager wakes itself in a loop.

import { Database } from "bun:sqlite";
import { tx, nextRev } from "./db";

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
// its tasks row. Starts nothing. The REQUEST is operator-authored, so it
// takes a rev (spec §2.4, §4.2).
export function initRun(db: Database, goalText: string): InitResult {
  return tx(db, () => {
    const managerSessionId = crypto.randomUUID();
    const now = nowIso();

    const runRow = db
      .query(
        `INSERT INTO runs (status, manager_session_id, rev_counter, manager_reacted_rev, manager_turns, created_at)
         VALUES ('running', ?, 0, 0, 0, ?)
         RETURNING id`
      )
      .get(managerSessionId, now) as { id: number };
    const runId = runRow.id;

    const rev = nextRev(db, runId);

    const msgRow = db
      .query(
        `INSERT INTO messages (run_id, author, type, ref_id, body, title, options, rev, created_at)
         VALUES (?, 'operator', 'REQUEST', NULL, ?, NULL, NULL, ?, ?)
         RETURNING id`
      )
      .get(runId, goalText, rev, now) as { id: number };
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

// spec §5 `synapse task`: the manager creates a subtask row, up front or
// on the fly. No rev — this is a manager write. Dispatch/spawn is out of
// Phase 1 scope; this only creates the row.
export function createSubtask(db: Database, args: CreateSubtaskArgs): number {
  return tx(db, () => {
    const now = nowIso();
    const row = db
      .query(
        `INSERT INTO subtasks (run_id, task_id, title, assignee_role, depends_on, stage, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'unassigned', ?, ?)
         RETURNING id`
      )
      .get(args.runId, args.taskId, args.title, args.assigneeRole, JSON.stringify(args.dependsOn), now, now) as {
      id: number;
    };
    return row.id;
  });
}

// spec §4.7: no deps -> a fresh git worktree; has deps -> inherit the
// worktree of the first dep (its subject). Tier 1 serializes at most one
// running worker acting in the repo directly (spec §4.7), so "fresh
// worktree" for Tier 1 is the repo root itself — there is never a second
// concurrent worker to isolate from. Tier 2 (Phase 8) is where this
// resolves to a real `git worktree add` path instead.
// No rev — dispatch-time bookkeeping, not a write the manager owes a
// reaction to.
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
          `resolveWorktreePath: subject ${deps[0]} has no worktree_path yet — dispatch its subject before subtask ${subtaskId}`
        );
      }
      path = subject.worktree_path;
    }

    db.query("UPDATE subtasks SET worktree_path = ? WHERE id = ?").run(path, subtaskId);
    return path;
  });
}

export class SubtaskTerminalError extends Error {}

// spec §4.6, §4.2: reply against any terminal row (done/cancelled/failed) is
// rejected. Worker write, stage -> done: assigns a rev.
export function replySubtask(
  db: Database,
  subtaskId: number,
  resultSummary: string,
  artifactPath: string | null
): number {
  return tx(db, () => {
    const row = db.query("SELECT stage, run_id FROM subtasks WHERE id = ?").get(subtaskId) as
      | { stage: string; run_id: number }
      | null;
    if (!row) throw new Error(`replySubtask: no subtask ${subtaskId}`);
    if (row.stage === "cancelled" || row.stage === "failed" || row.stage === "done") {
      throw new SubtaskTerminalError(
        `subtask ${subtaskId} is already ${row.stage}; reply rejected`
      );
    }

    const rev = nextRev(db, row.run_id);
    const now = nowIso();
    db.query(
      `UPDATE subtasks
       SET stage = 'done', result_summary = ?, artifact_path = ?, rev = ?, updated_at = ?
       WHERE id = ?`
    ).run(resultSummary, artifactPath, rev, now, subtaskId);
    return rev;
  });
}

// spec §4.5: wrapper/sweep failure write, stage -> failed. Assigns a rev.
// Included as a write primitive (CLAUDE.md names it as subtasks.ts's job);
// no CLI verb invokes it in Phase 1 — spawning/the wrapper is out of scope.
export function failSubtask(db: Database, subtaskId: number, resultSummary: string): number {
  return tx(db, () => {
    const row = db.query("SELECT stage, run_id FROM subtasks WHERE id = ?").get(subtaskId) as
      | { stage: string; run_id: number }
      | null;
    if (!row) throw new Error(`failSubtask: no subtask ${subtaskId}`);
    if (row.stage === "cancelled" || row.stage === "failed" || row.stage === "done") {
      throw new SubtaskTerminalError(
        `subtask ${subtaskId} is already ${row.stage}; fail rejected`
      );
    }

    const rev = nextRev(db, row.run_id);
    const now = nowIso();
    db.query(
      `UPDATE subtasks SET stage = 'failed', result_summary = ?, rev = ?, updated_at = ? WHERE id = ?`
    ).run(resultSummary, rev, now, subtaskId);
    return rev;
  });
}

// spec §4.6: cancel-cascade write, stage -> cancelled. Assigns a rev.
// Included as a write primitive; no CLI verb invokes it in Phase 1 — the
// watcher that triggers cascades is out of scope.
export function cancelSubtask(db: Database, subtaskId: number, cancelReason: string): number {
  return tx(db, () => {
    const row = db.query("SELECT stage, run_id FROM subtasks WHERE id = ?").get(subtaskId) as
      | { stage: string; run_id: number }
      | null;
    if (!row) throw new Error(`cancelSubtask: no subtask ${subtaskId}`);
    if (row.stage === "done" || row.stage === "failed" || row.stage === "cancelled") {
      throw new SubtaskTerminalError(
        `subtask ${subtaskId} is already ${row.stage}; cancel rejected`
      );
    }

    const rev = nextRev(db, row.run_id);
    const now = nowIso();
    db.query(
      `UPDATE subtasks
       SET stage = 'cancelled', cancel_reason = ?, cancelled_at = ?, rev = ?, updated_at = ?
       WHERE id = ?`
    ).run(cancelReason, now, rev, now, subtaskId);
    return rev;
  });
}

// spec §4.6: synapse done closes the run once every task is terminal.
// Gates on task_progress (queries.ts), never on stored status. No rev —
// manager/operator-triggered closure write.
export function closeRun(db: Database, runId: number): void {
  tx(db, () => {
    const now = nowIso();
    db.query("UPDATE runs SET status = 'done', ended_at = ? WHERE id = ?").run(now, runId);
  });
}
