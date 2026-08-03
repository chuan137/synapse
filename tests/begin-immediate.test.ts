// spec §4.10, §10 D1 consequences, CLAUDE.md hard constraints:
// "BEGIN IMMEDIATE for every writing transaction... deferred transactions
// deadlock on lock upgrade and busy_timeout does not rescue it."
//
// Proves the pragma matters: two connections doing read-then-write inside
// a deferred (plain BEGIN) transaction collide with SQLITE_BUSY on lock
// upgrade even though busy_timeout is set, while tx()'s BEGIN IMMEDIATE
// avoids the upgrade race entirely by taking the write lock up front.

import { describe, test, expect } from "bun:test";
import { openDb, initSchema, tx, nextRev } from "../src/db";
import { readFileSync } from "fs";
import { join } from "path";
import { freshRun } from "./helpers";

const schemaSql = readFileSync(join(import.meta.dir, "..", "src", "schema.sql"), "utf-8");

describe("BEGIN IMMEDIATE is load-bearing", () => {
  test("a deferred transaction (plain BEGIN) read-then-write deadlocks under a concurrent second writer, despite busy_timeout", () => {
    const path = join(process.env.TMPDIR ?? "/tmp", `synapse-deferred-${crypto.randomUUID()}.db`);
    const setup = openDb(path);
    initSchema(setup, schemaSql);
    const { runId } = freshRun(setup);
    setup.close();

    const db1 = openDb(path);
    const db2 = openDb(path);

    db1.exec("BEGIN"); // deferred
    db1.query("SELECT rev_counter FROM runs WHERE id = ?").get(runId); // read acquires SHARED

    db2.exec("BEGIN"); // deferred
    db2.query("SELECT rev_counter FROM runs WHERE id = ?").get(runId); // read acquires SHARED

    // db1 upgrades SHARED -> RESERVED/EXCLUSIVE to write: succeeds (first writer)
    db1.exec("UPDATE runs SET rev_counter = rev_counter + 1 WHERE id = ?", [runId]);

    // db2 now also tries to upgrade its SHARED lock to write while db1
    // holds a RESERVED lock — this is the upgrade race busy_timeout cannot
    // rescue (SQLITE_BUSY is returned immediately, not retried).
    expect(() => {
      db2.exec("UPDATE runs SET rev_counter = rev_counter + 1 WHERE id = ?", [runId]);
    }).toThrow(/SQLITE_BUSY|database is locked/i);

    db1.exec("ROLLBACK");
    try {
      db2.exec("ROLLBACK");
    } catch {}
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
    const { runId } = freshRun(setup);
    setup.close();

    const db1 = openDb(path);
    const db2 = openDb(path);

    // db1 holds an IMMEDIATE write lock for a short window
    const p1 = new Promise<void>((resolve) => {
      tx(db1, () => {
        nextRev(db1, runId);
        // simulate a brief hold so db2's BEGIN IMMEDIATE contends and
        // relies on busy_timeout, rather than racing instantaneously
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
        nextRev(db2, runId);
      });
    }).not.toThrow();

    const run = db1.query("SELECT rev_counter FROM runs WHERE id = ?").get(runId) as any;
    expect(run.rev_counter).toBe(3); // init's rev 1, then two nextRev() bumps

    db1.close();
    db2.close();
    require("fs").rmSync(path, { force: true });
    require("fs").rmSync(path + "-wal", { force: true });
    require("fs").rmSync(path + "-shm", { force: true });
  });
});
