// spec §4.6, §6: "synapse reply against a row already in cancelled or
// failed is rejected, so a killed worker's dying write cannot revive it."

import { describe, test, expect } from "bun:test";
import { freshDb, freshRun } from "./helpers";
import { createSubtask, replySubtask, failSubtask, cancelSubtask, SubtaskTerminalError } from "../src/subtasks";

describe("synapse reply against a terminal row", () => {
  test("reply against a failed row is rejected and the row is unchanged", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const s1 = createSubtask(db, { runId, taskId, title: "a", assigneeRole: "coder", dependsOn: [] });
    failSubtask(db, s1, "exit 1");

    const before = db.query("SELECT * FROM subtasks WHERE id = ?").get(s1);

    expect(() => replySubtask(db, s1, "late reply", null)).toThrow(SubtaskTerminalError);

    const after = db.query("SELECT * FROM subtasks WHERE id = ?").get(s1);
    expect(after).toEqual(before as any);
  });

  test("reply against a cancelled row is rejected and the row is unchanged", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const s1 = createSubtask(db, { runId, taskId, title: "a", assigneeRole: "coder", dependsOn: [] });
    cancelSubtask(db, s1, "dependency 99 failed");

    const before = db.query("SELECT * FROM subtasks WHERE id = ?").get(s1);

    expect(() => replySubtask(db, s1, "a killed worker's dying write", null)).toThrow(SubtaskTerminalError);

    const after = db.query("SELECT * FROM subtasks WHERE id = ?").get(s1);
    expect(after).toEqual(before as any);
  });

  test("a rejected late reply leaves delivered=0 unchanged (no side effect)", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const s1 = createSubtask(db, { runId, taskId, title: "a", assigneeRole: "coder", dependsOn: [] });
    failSubtask(db, s1, "exit 1");

    const before = db.query("SELECT delivered FROM subtasks WHERE id = ?").get(s1) as any;
    expect(() => replySubtask(db, s1, "late", null)).toThrow();
    const after = db.query("SELECT delivered FROM subtasks WHERE id = ?").get(s1) as any;
    expect(after.delivered).toBe(before.delivered); // unchanged
  });

  test("reply against a done row (second reply / liar case) is rejected — no field overwritten by a second worker (spec §6)", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const s1 = createSubtask(db, { runId, taskId, title: "a", assigneeRole: "coder", dependsOn: [] });
    replySubtask(db, s1, "first reply", null);

    const before = db.query("SELECT * FROM subtasks WHERE id = ?").get(s1) as any;
    expect(() => replySubtask(db, s1, "second reply (liar)", null)).toThrow(SubtaskTerminalError);
    const after = db.query("SELECT * FROM subtasks WHERE id = ?").get(s1) as any;

    expect(after).toEqual(before);
    expect(after.result_summary).toBe("first reply");
  });
});
