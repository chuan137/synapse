// spec §4.1, §6: "synapse init produces a run with manager_turns=0, a
// generated manager_session_id, one REQUEST, and one task linked by
// source_message_id."

import { describe, test, expect } from "bun:test";
import { freshDb, freshRun } from "./helpers";

describe("synapse init", () => {
  test("a rev is assigned by worker/operator writes and not by manager writes — init's REQUEST is operator-authored and takes rev 1", () => {
    const db = freshDb();
    const { runId, managerSessionId, messageId, taskId } = freshRun(db, "build the widget");

    const run = db.query("SELECT * FROM runs WHERE id = ?").get(runId) as any;
    expect(run.manager_turns).toBe(0);
    expect(run.manager_session_id).toBe(managerSessionId);
    expect(run.manager_session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(run.status).toBe("running");
    expect(run.rev_counter).toBe(1);

    const messages = db.query("SELECT * FROM messages WHERE run_id = ?").all(runId) as any[];
    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe(messageId);
    expect(messages[0].type).toBe("REQUEST");
    expect(messages[0].author).toBe("operator");
    expect(messages[0].rev).toBe(1);

    const tasks = db.query("SELECT * FROM tasks WHERE run_id = ?").all(runId) as any[];
    expect(tasks.length).toBe(1);
    expect(tasks[0].id).toBe(taskId);
    expect(tasks[0].source_message_id).toBe(messageId);
    expect(tasks[0].text).toBe("build the widget");
    expect(tasks[0].status).toBe("open");
  });

  test("init starts nothing — no subtasks exist after init", () => {
    const db = freshDb();
    const { runId } = freshRun(db);
    const subtasks = db.query("SELECT * FROM subtasks WHERE run_id = ?").all(runId);
    expect(subtasks.length).toBe(0);
  });

  test("each call to init produces a distinct generated manager_session_id", () => {
    const db = freshDb();
    const a = freshRun(db, "goal a");
    const b = freshRun(db, "goal b");
    expect(a.managerSessionId).not.toBe(b.managerSessionId);
  });
});
