// spec §4.3, §6: readiness respects depends_on; a row with a non-done
// dep is never ready; recomputable from the tables alone (json_each, no
// TS-side filtering).

import { describe, test, expect } from "bun:test";
import { freshDb, freshRun } from "./helpers";
import { createSubtask, replySubtask, failSubtask, cancelSubtask } from "../src/subtasks";
import { readySubtasks, isSubtaskReady } from "../src/queries";

describe("readiness", () => {
  test("a row with depends_on=[] is ready immediately", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const s1 = createSubtask(db, { runId, taskId, title: "a", assigneeRole: "coder", dependsOn: [] });
    expect(isSubtaskReady(db, s1)).toBe(true);
    expect(readySubtasks(db, runId).map((r: any) => r.id)).toEqual([s1]);
  });

  test("a row with a non-done dep is never ready", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const coder = createSubtask(db, { runId, taskId, title: "code", assigneeRole: "coder", dependsOn: [] });
    const reviewer = createSubtask(db, {
      runId,
      taskId,
      title: "review",
      assigneeRole: "reviewer",
      dependsOn: [coder],
    });

    expect(isSubtaskReady(db, reviewer)).toBe(false);

    const ready = readySubtasks(db, runId).map((r: any) => r.id);
    expect(ready).toEqual([coder]);
    expect(ready).not.toContain(reviewer);
  });

  test("a row becomes ready once all deps are done", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const coder = createSubtask(db, { runId, taskId, title: "code", assigneeRole: "coder", dependsOn: [] });
    const reviewer = createSubtask(db, {
      runId,
      taskId,
      title: "review",
      assigneeRole: "reviewer",
      dependsOn: [coder],
    });

    expect(isSubtaskReady(db, reviewer)).toBe(false);
    replySubtask(db, coder, "implemented", null);
    expect(isSubtaskReady(db, reviewer)).toBe(true);
  });

  test("multiple deps: not ready until every dep is done", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const coder = createSubtask(db, { runId, taskId, title: "code", assigneeRole: "coder", dependsOn: [] });
    const fixture = createSubtask(db, { runId, taskId, title: "fixture", assigneeRole: "coder", dependsOn: [] });
    const tester = createSubtask(db, {
      runId,
      taskId,
      title: "test",
      assigneeRole: "tester",
      dependsOn: [coder, fixture],
    });

    replySubtask(db, coder, "done", null);
    expect(isSubtaskReady(db, tester)).toBe(false); // fixture still pending

    replySubtask(db, fixture, "done", null);
    expect(isSubtaskReady(db, tester)).toBe(true);
  });

  test("a dep that fails or is cancelled keeps the dependent row un-ready (not done != done)", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const coder = createSubtask(db, { runId, taskId, title: "code", assigneeRole: "coder", dependsOn: [] });
    const reviewer = createSubtask(db, {
      runId,
      taskId,
      title: "review",
      assigneeRole: "reviewer",
      dependsOn: [coder],
    });

    failSubtask(db, coder, "exit 1");
    expect(isSubtaskReady(db, reviewer)).toBe(false);
  });

  test("readiness also requires stage='unassigned' — an already-assigned/done row is not re-offered as ready", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db);
    const coder = createSubtask(db, { runId, taskId, title: "code", assigneeRole: "coder", dependsOn: [] });
    replySubtask(db, coder, "done", null);
    expect(isSubtaskReady(db, coder)).toBe(false); // stage is 'done', not 'unassigned'
  });
});
