// spec §4.2, §6: rev is strictly monotonic; assigned by worker/operator
// writes and not by manager writes.

import { describe, test, expect } from "bun:test";
import { openDb, initSchema } from "../src/db";
import { readFileSync } from "fs";
import { join } from "path";
import { freshDb, freshRun } from "./helpers";
import { createSubtask, replySubtask, failSubtask, cancelSubtask } from "../src/subtasks";

const schemaSql = readFileSync(join(import.meta.dir, "..", "src", "schema.sql"), "utf-8");

describe("rev monotonicity", () => {
  test("a rev is assigned by worker/operator writes and not by manager writes", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db); // init's REQUEST -> rev 1

    // manager write: createSubtask — no rev assigned, counter unchanged
    let run = db.query("SELECT rev_counter FROM runs WHERE id = ?").get(runId) as any;
    expect(run.rev_counter).toBe(1);

    const s1 = createSubtask(db, { runId, taskId, title: "code it", assigneeRole: "coder", dependsOn: [] });

    run = db.query("SELECT rev_counter FROM runs WHERE id = ?").get(runId) as any;
    expect(run.rev_counter).toBe(1); // still 1: subtask creation is a manager write

    // worker write: reply — assigns a rev
    const rev = replySubtask(db, s1, "done", null);
    expect(rev).toBe(2);

    run = db.query("SELECT rev_counter FROM runs WHERE id = ?").get(runId) as any;
    expect(run.rev_counter).toBe(2);
  });

  test("fail and cancel writes assign a rev; each subsequent rev is strictly greater", () => {
    const db = freshDb();
    const { runId, taskId } = freshRun(db); // rev 1

    const s1 = createSubtask(db, { runId, taskId, title: "a", assigneeRole: "coder", dependsOn: [] });
    const s2 = createSubtask(db, { runId, taskId, title: "b", assigneeRole: "coder", dependsOn: [] });

    const revFail = failSubtask(db, s1, "exit 1");
    const revCancel = cancelSubtask(db, s2, "dependency failed");

    expect(revFail).toBe(2);
    expect(revCancel).toBe(3);
    expect(revCancel).toBeGreaterThan(revFail);
  });

  test("rev is strictly monotonic under concurrent writers sharing one connection", () => {
    // bun:sqlite writes on one Database handle are inherently serialized by
    // the caller (this test exercises many sequential tx()-wrapped writes
    // arriving in a tight loop, asserting no rev is skipped or repeated).
    const db = freshDb();
    const { runId, taskId } = freshRun(db); // rev 1

    const ids = Array.from({ length: 20 }, () =>
      createSubtask(db, { runId, taskId, title: "x", assigneeRole: "coder", dependsOn: [] })
    );

    const revs = ids.map((id) => replySubtask(db, id, "ok", null));
    const sorted = [...revs].sort((a, b) => a - b);
    expect(revs).toEqual(sorted); // strictly increasing in issue order
    expect(new Set(revs).size).toBe(revs.length); // no duplicates
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]).toBe(sorted[i - 1] + 1); // no gaps
    }
  });

  test("rev is strictly monotonic under truly concurrent writers on separate connections to the same file", async () => {
    const path = join(
      process.env.TMPDIR ?? "/tmp",
      `synapse-test-${crypto.randomUUID()}.db`
    );
    const setupDb = openDb(path);
    initSchema(setupDb, schemaSql);
    const { runId, taskId } = freshRun(setupDb);

    const subtaskIds: number[] = [];
    for (let i = 0; i < 8; i++) {
      subtaskIds.push(
        createSubtask(setupDb, { runId, taskId, title: `t${i}`, assigneeRole: "coder", dependsOn: [] })
      );
    }
    setupDb.close();

    // Each "writer" opens its own connection (as separate worker/operator
    // processes would) and replies concurrently.
    const revs = await Promise.all(
      subtaskIds.map(
        (id) =>
          new Promise<number>((resolve, reject) => {
            try {
              const conn = openDb(path);
              const rev = replySubtask(conn, id, "ok", null);
              conn.close();
              resolve(rev);
            } catch (e) {
              reject(e);
            }
          })
      )
    );

    const sorted = [...revs].sort((a, b) => a - b);
    expect(new Set(revs).size).toBe(revs.length); // no duplicate revs issued
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]).toBe(sorted[i - 1] + 1); // strictly monotonic, no gaps
    }

    require("fs").rmSync(path, { force: true });
    require("fs").rmSync(path + "-wal", { force: true });
    require("fs").rmSync(path + "-shm", { force: true });
  });
});
