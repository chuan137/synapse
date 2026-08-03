// spec §4.5 layer 1 (Stop hook), S0.3 (payload contract)
//
// Unit tests for cmdHookCheck's DB logic. The actual hooks/stop.ts script
// (stdin relay to `synapse hook-check`) is exercised only by a real Claude
// Code Stop hook firing — not unit-testable without a real worker turn;
// see docs/synapse-phase4-summary.md for how that exit criterion was
// verified instead.

import { describe, test, expect } from "bun:test";
import { freshDb, freshRun } from "./helpers";
import { createSubtask } from "../src/subtasks";
import { cmdHookCheck } from "../src/cli";

describe("cmdHookCheck (spec §4.5 layer 1)", () => {
  test("blocks when the session's subtask is assigned with no reply", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const subtaskId = createSubtask(db, { runId, taskId, title: "t", assigneeRole: "coder", dependsOn: [] });
    db.query("UPDATE subtasks SET stage = 'assigned', worker_session_id = ? WHERE id = ?").run(
      "sess-1",
      subtaskId
    );

    const result = cmdHookCheck(db, { session_id: "sess-1", stop_hook_active: false });
    expect(result.decision).toBe("block");
    expect(result.reason).toContain(`subtask ${subtaskId}`);
  });

  test("allows the stop once a reply has landed (stage=done)", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const subtaskId = createSubtask(db, { runId, taskId, title: "t", assigneeRole: "coder", dependsOn: [] });
    db.query("UPDATE subtasks SET stage = 'done', worker_session_id = ? WHERE id = ?").run("sess-2", subtaskId);

    const result = cmdHookCheck(db, { session_id: "sess-2", stop_hook_active: false });
    expect(result).toEqual({});
  });

  test("allows the stop for a session_id not tied to any subtask", () => {
    const db = freshDb();
    freshRun(db);

    const result = cmdHookCheck(db, { session_id: "unknown-session", stop_hook_active: false });
    expect(result).toEqual({});
  });

  test("allows the stop once the row is failed (wrapper or sweep already caught it)", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const subtaskId = createSubtask(db, { runId, taskId, title: "t", assigneeRole: "coder", dependsOn: [] });
    db.query("UPDATE subtasks SET stage = 'failed', worker_session_id = ? WHERE id = ?").run(
      "sess-3",
      subtaskId
    );

    const result = cmdHookCheck(db, { session_id: "sess-3", stop_hook_active: false });
    expect(result).toEqual({});
  });

  test("blocks again on a forced re-invocation (stop_hook_active=true) if still no reply", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const subtaskId = createSubtask(db, { runId, taskId, title: "t", assigneeRole: "coder", dependsOn: [] });
    db.query("UPDATE subtasks SET stage = 'assigned', worker_session_id = ? WHERE id = ?").run(
      "sess-4",
      subtaskId
    );

    const result = cmdHookCheck(db, { session_id: "sess-4", stop_hook_active: true });
    expect(result.decision).toBe("block");
  });
});
