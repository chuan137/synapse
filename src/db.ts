// spec §4.10, §4.2; CLAUDE.md hard constraints
//
// Synchronous bun:sqlite. No ORM, no async DB layer. tx() wraps BEGIN
// IMMEDIATE — never a deferred transaction — because every write path that
// reads a row's stage then writes it must hold the write lock for the whole
// read-then-write sequence. Two deferred transactions doing that concurrently
// deadlock on lock upgrade (busy_timeout does not rescue an upgrade).
//
// nextRev() is gone as of phase 4.5 C2: the rev counter and
// manager_reacted_rev mark are replaced by per-row `delivered` flags.
// BEGIN IMMEDIATE is still required: replySubtask reads stage then writes
// it, so the read-then-write invariant is unchanged (S0.5 finding stands).

import { Database } from "bun:sqlite";

export function openDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

export function initSchema(db: Database, schemaSql: string): void {
  db.exec(schemaSql);
}

// Wraps fn in BEGIN IMMEDIATE / COMMIT, rolling back on throw.
export function tx<T>(db: Database, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
