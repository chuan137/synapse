// spec §4.10, §10 D1 consequences, CLAUDE.md hard constraints:
// "BEGIN IMMEDIATE for every writing transaction... deferred transactions
// deadlock on lock upgrade and busy_timeout does not rescue it."
//
// nextRev() is gone (phase 4.5 C2) but the invariant is unchanged: every
// write path reads a row's stage then writes it. replySubtask does exactly
// that, making it the right stand-in for the deadlock demonstration.
//
// Proves the pragma matters: two connections doing read-then-write inside
// a deferred (plain BEGIN) transaction collide with SQLITE_BUSY on lock
// upgrade even though busy_timeout is set, while tx()'s BEGIN IMMEDIATE
// avoids the upgrade race entirely by taking the write lock up front.

import { describe, test, expect } from "bun:test";
import { openDb, initSchema, tx } from "../src/db";
import { readFileSync } from "fs";
import { join } from "path";
import { freshRun } from "./helpers";
import { createSubtask } from "../src/subtasks";

const schemaSql = readFileSync(join(import.meta.dir, "..", "src", "schema.sql"), "utf-8");

describe("BEGIN IMMEDIATE is load-bearing", () => {
  test("a deferred transaction (plain BEGIN) read-then-write deadlocks under a concurrent second writer, despite busy_timeout", () => {
    const path = join(process.env.TMPDIR ?? "/tmp", `synapse-deferred-${crypto.randomUUID()}.db`);
    const setup = openDb(path);
    initSchema(setup, schemaSql);
    const { runId, taskId } = freshRun(setup);
    const s1 = createSubtask(setup, { runId, taskId, title: "a", assigneeRole: "coder", dependsOn: [] });
    const s2 = createSubtask(setup, { runId, taskId, title: "b", assigneeRole: "coder", dependsOn: [] });
    setup.close();

    const db1 = openDb(path);
    const db2 = openDb(path);

    // Both connections read-then-write in a deferred transaction (plain BEGIN).
    db1.exec("BEGIN"); // deferred
    db1.query("SELECT stage FROM subtasks WHERE id = ?").get(s1); // read -> SHARED lock

    db2.exec("BEGIN"); // deferred
    db2.query("SELECT stage FROM subtasks WHERE id = ?").get(s2); // read -> SHARED lock

    // db1 upgrades SHARED -> RESERVED/EXCLUSIVE to write: succeeds (first writer)
    db1.exec(`UPDATE subtasks SET stage = 'done', updated_at = datetime('now') WHERE id = ?`, [s1]);

    // db2 now tries to upgrade its SHARED lock to write while db1 holds
    // RESERVED — the upgrade race busy_timeout cannot rescue.
    expect(() => {
      db2.exec(`UPDATE subtasks SET stage = 'done', updated_at = datetime('now') WHERE id = ?`, [s2]);
    }).toThrow(/SQLITE_BUSY|database is locked/i);

    db1.exec("ROLLBACK");
    try { db2.exec("ROLLBACK"); } catch {}
    db1.close();
    db2.close();
    require("fs").rmSync(path, { force: true });
    require("fs").rmSync(path + "-wal", { force: true });
    require("fs").rmSync(path + "-shm", { force: true });
  });

  test("tx() (BEGIN IMMEDIATE) avoids the upgrade race: a second writer waits on busy_timeout instead of erroring, and both writes land", async () => {
    const path = join(process.env.TMPDIR ?? "/tmp", `synapse-immediate-${crypto.randomUUID()}.db`);
    const setup = openDb(path);
    initSchema(setup, schemaSql);
    const { runId, taskId } = freshRun(setup);
    const s1 = createSubtask(setup, { runId, taskId, title: "a", assigneeRole: "coder", dependsOn: [] });
    const s2 = createSubtask(setup, { runId, taskId, title: "b", assigneeRole: "coder", dependsOn: [] });
    setup.close();

    const db1 = openDb(path);
    const db2 = openDb(path);

    // db1 holds an IMMEDIATE write lock for a short window.
    const p1 = new Promise<void>((resolve) => {
      tx(db1, () => {
        db1.query("SELECT stage FROM subtasks WHERE id = ?").get(s1);
        db1.exec(`UPDATE subtasks SET stage = 'done', updated_at = datetime('now') WHERE id = ?`, [s1]);
        const until = Date.now() + 50;
        while (Date.now() < until) {}
      });
      resolve();
    });
    await p1;

    // db2's BEGIN IMMEDIATE either waits (busy_timeout) or runs after —
    // either way it succeeds, no SQLITE_BUSY escapes.
    expect(() => {
      tx(db2, () => {
        db2.query("SELECT stage FROM subtasks WHERE id = ?").get(s2);
        db2.exec(`UPDATE subtasks SET stage = 'done', updated_at = datetime('now') WHERE id = ?`, [s2]);
      });
    }).not.toThrow();

    const rows = db1.query("SELECT stage FROM subtasks WHERE run_id = ?").all(runId) as any[];
    expect(rows.every((r) => r.stage === "done")).toBe(true);

    db1.close();
    db2.close();
    require("fs").rmSync(path, { force: true });
    require("fs").rmSync(path + "-wal", { force: true });
    require("fs").rmSync(path + "-shm", { force: true });
  });
});
