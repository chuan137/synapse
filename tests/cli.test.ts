// Exercises the Phase 1 CLI verbs (init, task, reply, verdict, status, done)
// through dispatch(), not just the underlying library functions.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { openDb, initSchema } from "../src/db";
import { dispatch } from "../src/cli";
import { readFileSync } from "fs";
import { join } from "path";

const schemaSql = readFileSync(join(import.meta.dir, "..", "src", "schema.sql"), "utf-8");

function freshCliDb() {
  const db = openDb(":memory:");
  initSchema(db, schemaSql);
  return db;
}

let logs: string[] = [];
let errors: string[] = [];
const origLog = console.log;
const origError = console.error;

beforeEach(() => {
  logs = [];
  errors = [];
  console.log = (...args: any[]) => logs.push(args.join(" "));
  console.error = (...args: any[]) => errors.push(args.join(" "));
});

afterEach(() => {
  console.log = origLog;
  console.error = origError;
});

describe("cli dispatch", () => {
  test("init creates a run and task, printed as JSON", () => {
    const db = freshCliDb();
    dispatch(db, ["init", "--goal", "ship the thing"]);
    const out = JSON.parse(logs[0]);
    expect(out.runId).toBeGreaterThan(0);
    expect(out.taskId).toBeGreaterThan(0);
  });

  test("task creates a subtask row under the run/task from init", () => {
    const db = freshCliDb();
    dispatch(db, ["init", "--goal", "ship the thing"]);
    const { runId, taskId } = JSON.parse(logs[0]);
    logs = [];

    dispatch(db, ["task", "coder", "implement the thing", "--run", String(runId), "--task-id", String(taskId)]);
    const out = JSON.parse(logs[0]);
    expect(out.subtaskId).toBeGreaterThan(0);

    const row = db.query("SELECT * FROM subtasks WHERE id = ?").get(out.subtaskId) as any;
    expect(row.stage).toBe("unassigned");
    expect(row.assignee_role).toBe("coder");
    expect(row.depends_on).toBe("[]");
  });

  test("task with --depends-on records the dependency edge", () => {
    const db = freshCliDb();
    dispatch(db, ["init", "--goal", "g"]);
    const { runId, taskId } = JSON.parse(logs[0]);
    logs = [];

    dispatch(db, ["task", "coder", "code", "--run", String(runId), "--task-id", String(taskId)]);
    const { subtaskId: coderId } = JSON.parse(logs[0]);
    logs = [];

    dispatch(db, [
      "task", "reviewer", "review",
      "--run", String(runId), "--task-id", String(taskId),
      "--depends-on", String(coderId),
    ]);
    const { subtaskId: reviewerId } = JSON.parse(logs[0]);

    const row = db.query("SELECT depends_on FROM subtasks WHERE id = ?").get(reviewerId) as any;
    expect(JSON.parse(row.depends_on)).toEqual([coderId]);
  });

  test("reply marks a subtask done (delivered=0 until watcher delivers)", () => {
    const db = freshCliDb();
    dispatch(db, ["init", "--goal", "g"]);
    const { runId, taskId } = JSON.parse(logs[0]);
    logs = [];
    dispatch(db, ["task", "coder", "code", "--run", String(runId), "--task-id", String(taskId)]);
    const { subtaskId } = JSON.parse(logs[0]);
    logs = [];

    dispatch(db, ["reply", String(subtaskId), "implemented it"]);
    const out = JSON.parse(logs[0]);
    expect(out.subtaskId).toBe(subtaskId);

    const row = db.query("SELECT stage, result_summary, delivered FROM subtasks WHERE id = ?").get(subtaskId) as any;
    expect(row.stage).toBe("done");
    expect(row.result_summary).toBe("implemented it");
    expect(row.delivered).toBe(0); // watcher delivers after the turn completes
  });

  test("verdict writes the ruling and does not touch delivered", () => {
    const db = freshCliDb();
    dispatch(db, ["init", "--goal", "g"]);
    const { runId, taskId } = JSON.parse(logs[0]);
    logs = [];
    dispatch(db, ["task", "coder", "code", "--run", String(runId), "--task-id", String(taskId)]);
    const { subtaskId } = JSON.parse(logs[0]);
    logs = [];
    dispatch(db, ["reply", String(subtaskId), "done"]);
    logs = [];

    dispatch(db, ["verdict", String(subtaskId), "LGTM"]);
    const out = JSON.parse(logs[0]);
    expect(out.subtaskId).toBe(subtaskId);

    const row = db.query("SELECT verdict, delivered FROM subtasks WHERE id = ?").get(subtaskId) as any;
    expect(row.verdict).toBe("LGTM");
    expect(row.delivered).toBe(0); // verdict never touches delivered (§4.2, §7)
  });

  test("reply exits non-zero and logs an error against a terminal row", () => {
    const db = freshCliDb();
    dispatch(db, ["init", "--goal", "g"]);
    const { runId, taskId } = JSON.parse(logs[0]);
    logs = [];
    dispatch(db, ["task", "coder", "code", "--run", String(runId), "--task-id", String(taskId)]);
    const { subtaskId } = JSON.parse(logs[0]);
    dispatch(db, ["reply", String(subtaskId), "first"]);

    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; throw new Error("__exit__"); }) as typeof process.exit;
    try {
      expect(() => dispatch(db, ["reply", String(subtaskId), "second (liar)"])).toThrow();
    } finally {
      process.exit = originalExit;
    }
    expect(exitCode).toBe(1);
    expect(errors.length).toBeGreaterThan(0);
  });

  test("status --json renders run -> tasks -> subtasks with readiness", () => {
    const db = freshCliDb();
    dispatch(db, ["init", "--goal", "g"]);
    const { runId, taskId } = JSON.parse(logs[0]);
    logs = [];
    dispatch(db, ["task", "coder", "code", "--run", String(runId), "--task-id", String(taskId)]);
    logs = [];

    dispatch(db, ["status", "--run", String(runId), "--json"]);
    const view = JSON.parse(logs[0]);
    expect(view.run.id).toBe(runId);
    expect(view.tasks.length).toBe(1);
    expect(view.tasks[0].subtasks.length).toBe(1);
    expect(view.tasks[0].subtasks[0].ready).toBe(true);
  });

  test("done blocks (exit 1) while non-terminal, succeeds once work_closed", () => {
    const db = freshCliDb();
    dispatch(db, ["init", "--goal", "g"]);
    const { runId, taskId } = JSON.parse(logs[0]);
    logs = [];
    dispatch(db, ["task", "coder", "code", "--run", String(runId), "--task-id", String(taskId)]);
    const { subtaskId } = JSON.parse(logs[0]);

    const originalExit = process.exit;
    let exitCode: number | undefined;
    process.exit = ((code?: number) => { exitCode = code; throw new Error("__exit__"); }) as typeof process.exit;
    try {
      expect(() => dispatch(db, ["done", "--run", String(runId)])).toThrow();
    } finally {
      process.exit = originalExit;
    }
    expect(exitCode).toBe(1);

    // Reply and deliver (simulating what the watcher does after a completed turn).
    dispatch(db, ["reply", String(subtaskId), "done"]);
    db.query("UPDATE subtasks SET delivered = 1 WHERE id = ?").run(subtaskId);
    logs = [];

    dispatch(db, ["done", "--run", String(runId)]);
    const out = JSON.parse(logs[0]);
    expect(out.status).toBe("done");

    const run = db.query("SELECT status FROM runs WHERE id = ?").get(runId) as any;
    expect(run.status).toBe("done");
  });
});
