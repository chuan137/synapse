// spec §2.2, §4.6, §6:
// - task_progress.work_settled is false for a zero-subtask task.
// - synapse done blocks while any subtask is non-terminal; allows when
//   all are terminal including cancelled.

import { describe, test, expect } from "bun:test";
import { freshDb, freshRun } from "./helpers";
import { createSubtask, replySubtask, failSubtask, cancelSubtask, closeRun } from "../src/subtasks";
import { taskProgress, runIsDone } from "../src/queries";

describe("task_progress and synapse done", () => {
  test("work_settled is false for a zero-subtask task", () => {
    const db = freshDb();
    const { taskId } = freshRun(db);
    const progress = taskProgress(db, taskId);
    expect(progress.n_subtasks).toBe(0);
    expect(progress.work_settled).toBe(0);
  });

  test("done blocks while any subtask is non-terminal", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const s1 = createSubtask(db, { runId, taskId, title: "a", assigneeRole: "coder", dependsOn: [] });
    createSubtask(db, { runId, taskId, title: "b", assigneeRole: "coder", dependsOn: [] });

    expect(runIsDone(db, runId)).toBe(false);

    replySubtask(db, s1, "done", null);
    // task status still 'open' (manager hasn't declared done) AND one subtask unterminal
    expect(runIsDone(db, runId)).toBe(false);
  });

  test("done allows when all subtasks are terminal including cancelled, and task.status is done", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const s1 = createSubtask(db, { runId, taskId, title: "a", assigneeRole: "coder", dependsOn: [] });
    const s2 = createSubtask(db, { runId, taskId, title: "b", assigneeRole: "coder", dependsOn: [] });
    const s3 = createSubtask(db, { runId, taskId, title: "c", assigneeRole: "coder", dependsOn: [] });

    replySubtask(db, s1, "done", null);
    failSubtask(db, s2, "exit 1");
    cancelSubtask(db, s3, "dependency failed");

    // work_settled true, but task.status still 'open' -> run not done yet
    let progress = taskProgress(db, taskId);
    expect(progress.work_settled).toBe(1);
    expect(runIsDone(db, runId)).toBe(false);

    // manager declares the task done
    db.query("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId);
    expect(runIsDone(db, runId)).toBe(true);
  });

  test("a task marked cancelled counts as terminal regardless of subtask settlement", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    createSubtask(db, { runId, taskId, title: "a", assigneeRole: "coder", dependsOn: [] });
    // subtask still unassigned/non-terminal, but task itself is cancelled
    db.query("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(taskId);
    expect(runIsDone(db, runId)).toBe(true);
  });

  test("closeRun sets run status=done and ended_at once gated open", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const s1 = createSubtask(db, { runId, taskId, title: "a", assigneeRole: "coder", dependsOn: [] });
    replySubtask(db, s1, "done", null);
    db.query("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId);
    expect(runIsDone(db, runId)).toBe(true);

    closeRun(db, runId);
    const run = db.query("SELECT * FROM runs WHERE id = ?").get(runId) as any;
    expect(run.status).toBe("done");
    expect(run.ended_at).not.toBeNull();
  });

  test("a run with multiple tasks is not done until every task is terminal", () => {
    const db = freshDb();
    const { runId, taskId: task1 } = freshRun(db, "goal 1");
    const task2Row = db
      .query("INSERT INTO tasks (run_id, text, status, created_at) VALUES (?, 'goal 2', 'open', datetime('now')) RETURNING id")
      .get(runId) as any;
    const task2 = task2Row.id;

    const s1 = createSubtask(db, { runId, taskId: task1, title: "a", assigneeRole: "coder", dependsOn: [] });
    replySubtask(db, s1, "done", null);
    db.query("UPDATE tasks SET status = 'done' WHERE id = ?").run(task1);

    expect(runIsDone(db, runId)).toBe(false); // task2 has zero subtasks, not terminal

    const s2 = createSubtask(db, { runId, taskId: task2, title: "b", assigneeRole: "coder", dependsOn: [] });
    replySubtask(db, s2, "done", null);
    db.query("UPDATE tasks SET status = 'done' WHERE id = ?").run(task2);

    expect(runIsDone(db, runId)).toBe(true);
  });
});
