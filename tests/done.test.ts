// spec §2.2, §4.2, §4.6, §6:
// - task_progress.work_settled is false for a zero-subtask task.
// - work_closed requires every subtask terminal AND delivered (§4.2).
// - synapse done gates on work_closed or tasks.status='cancelled'.
// - work_settled alone does not open the gate — the delivered clause is
//   load-bearing: the manager must have seen the batch in a completed turn.

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
    expect(progress.work_closed).toBe(0);
  });

  test("done blocks while any subtask is non-terminal", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const s1 = createSubtask(db, { runId, taskId, title: "a", assigneeRole: "coder", dependsOn: [] });
    createSubtask(db, { runId, taskId, title: "b", assigneeRole: "coder", dependsOn: [] });

    expect(runIsDone(db, runId)).toBe(false);

    replySubtask(db, s1, "done", null);
    expect(runIsDone(db, runId)).toBe(false); // s2 still non-terminal
  });

  test("work_closed waits for delivery: work_settled true but done still blocks until delivered", () => {
    // spec §6: "drive every subtask of a task terminal but let no manager
    // turn run; assert work_settled is true, work_closed is false, and
    // synapse done still blocks."
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const s1 = createSubtask(db, { runId, taskId, title: "a", assigneeRole: "coder", dependsOn: [] });
    const s2 = createSubtask(db, { runId, taskId, title: "b", assigneeRole: "coder", dependsOn: [] });
    const s3 = createSubtask(db, { runId, taskId, title: "c", assigneeRole: "coder", dependsOn: [] });

    replySubtask(db, s1, "done", null);
    failSubtask(db, s2, "exit 1");
    cancelSubtask(db, s3, "dependency failed"); // born delivered=1

    const progress = taskProgress(db, taskId);
    expect(progress.work_settled).toBe(1);
    // s1 (done, delivered=0) and s2 (failed, delivered=0) not yet delivered
    expect(progress.work_closed).toBe(0);
    expect(runIsDone(db, runId)).toBe(false);

    // Simulate the watcher delivering s1 and s2 after a completed turn.
    db.query("UPDATE subtasks SET delivered = 1 WHERE id IN (?, ?)").run(s1, s2);
    expect(taskProgress(db, taskId).work_closed).toBe(1);
    expect(runIsDone(db, runId)).toBe(true);
  });

  test("done allows when all subtasks are terminal and delivered (including cancelled)", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const s1 = createSubtask(db, { runId, taskId, title: "a", assigneeRole: "coder", dependsOn: [] });
    const s2 = createSubtask(db, { runId, taskId, title: "b", assigneeRole: "coder", dependsOn: [] });
    const s3 = createSubtask(db, { runId, taskId, title: "c", assigneeRole: "coder", dependsOn: [] });

    replySubtask(db, s1, "done", null);
    failSubtask(db, s2, "exit 1");
    cancelSubtask(db, s3, "dependency failed"); // born delivered=1

    // Deliver the non-cancelled rows (simulating watcher post-turn delivery).
    db.query("UPDATE subtasks SET delivered = 1 WHERE id IN (?, ?)").run(s1, s2);

    expect(runIsDone(db, runId)).toBe(true);
  });

  test("a task marked cancelled counts as terminal regardless of subtask settlement", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    createSubtask(db, { runId, taskId, title: "a", assigneeRole: "coder", dependsOn: [] });
    db.query("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(taskId);
    expect(runIsDone(db, runId)).toBe(true);
  });

  test("closeRun sets run status=done and ended_at once gated open", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const s1 = createSubtask(db, { runId, taskId, title: "a", assigneeRole: "coder", dependsOn: [] });
    replySubtask(db, s1, "done", null);

    // Not done yet — delivered=0.
    expect(runIsDone(db, runId)).toBe(false);

    // Deliver (simulating watcher).
    db.query("UPDATE subtasks SET delivered = 1 WHERE id = ?").run(s1);
    expect(runIsDone(db, runId)).toBe(true);

    closeRun(db, runId);
    const run = db.query("SELECT * FROM runs WHERE id = ?").get(runId) as any;
    expect(run.status).toBe("done");
    expect(run.ended_at).not.toBeNull();
  });

  test("a run with multiple tasks is not done until every task is work_closed", () => {
    const db = freshDb();
    const { runId, taskId: task1 } = freshRun(db, "goal 1");
    const task2Row = db
      .query("INSERT INTO tasks (run_id, text, status, created_at) VALUES (?, 'goal 2', 'open', datetime('now')) RETURNING id")
      .get(runId) as any;
    const task2 = task2Row.id;

    const s1 = createSubtask(db, { runId, taskId: task1, title: "a", assigneeRole: "coder", dependsOn: [] });
    replySubtask(db, s1, "done", null);
    db.query("UPDATE subtasks SET delivered = 1 WHERE id = ?").run(s1);

    expect(runIsDone(db, runId)).toBe(false); // task2 has zero subtasks

    const s2 = createSubtask(db, { runId, taskId: task2, title: "b", assigneeRole: "coder", dependsOn: [] });
    replySubtask(db, s2, "done", null);
    db.query("UPDATE subtasks SET delivered = 1 WHERE id = ?").run(s2);

    expect(runIsDone(db, runId)).toBe(true);
  });
});
