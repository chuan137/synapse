// spec §4.10, §4.2; CLAUDE.md hard constraints
//
// Synchronous bun:sqlite. No ORM, no async DB layer. tx() wraps BEGIN
// IMMEDIATE — never a deferred transaction — because every rev-assigning
// path reads a row's stage then writes it, and two deferred transactions
// doing that concurrently deadlock on lock upgrade (busy_timeout does not
// rescue an upgrade).

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

// Bumps and returns runs.rev_counter. Must be called inside the caller's
// own tx() — never opens one of its own (spec §4.2).
export function nextRev(db: Database, runId: number): number {
  const row = db
    .query("UPDATE runs SET rev_counter = rev_counter + 1 WHERE id = ? RETURNING rev_counter")
    .get(runId) as { rev_counter: number } | null;
  if (!row) throw new Error(`nextRev: no run ${runId}`);
  return row.rev_counter;
}
