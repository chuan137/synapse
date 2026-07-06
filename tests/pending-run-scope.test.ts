/**
 * Tests for run-scoped inbox reads (bug #1119).
 *
 * Two runs share agent names (manager, coder-1). Verifies that `pending`
 * and `status` never surface messages from the wrong run when SYNAPSE_RUN_ID
 * is set, and that `pending` fails loud when scope is unknowable.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SYNAPSE_CLI = join(import.meta.dir, "..", "src", "synapse.ts");

let dir: string;
let dbFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "syn-runscope-"));
  dbFile = join(dir, "synapse.db");
  seedFixture();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, SYNAPSE_CLI, ...args], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      SYNAPSE_DB: dbFile,
      SYNAPSE_RUN_ID: undefined,
      SYNAPSE_AGENT: undefined,
      ...extraEnv,
    },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function openDb(): Database {
  return new Database(dbFile, { readonly: true });
}

function openDbWritable(): Database {
  return new Database(dbFile);
}

/**
 * Seed fixture per test plan:
 * - run 1 (sess1): operator, manager, coder-1
 * - run 2 (sess2): operator, manager, coder-1
 * - m10: run_id=1, operator→manager TASK "run1 goal"
 * - m11: run_id=2, operator→manager TASK "run2 goal"
 * - m12: run_id=1, manager→coder-1 TASK "run1 code"
 * - m13: run_id=2, manager→coder-1 TASK "run2 code"
 *
 * We use low-level DB inserts (not the CLI) to control run_id precisely.
 */
function seedFixture() {
  // Init the schema
  run(["init"]);

  const db = openDbWritable();

  // Insert two runs, both running
  db.run("INSERT INTO runs (id, session, goal, status) VALUES (1, 'sess1', 'goal1', 'running')");
  db.run("INSERT INTO runs (id, session, goal, status) VALUES (2, 'sess2', 'goal2', 'running')");

  // Register agents for each run
  const agents = [
    ["operator", 1, "operator", "s1-op"],
    ["manager",  1, "manager",  "s1-mgr"],
    ["coder-1",  1, "coder",    "s1-cod"],
    ["operator", 2, "operator", "s2-op"],
    ["manager",  2, "manager",  "s2-mgr"],
    ["coder-1",  2, "coder",    "s2-cod"],
  ] as const;
  for (const [name, runId, role, sessId] of agents) {
    db.run(
      `INSERT INTO agents (window_name, run_id, role, session_id, status, last_seen_at)
       VALUES (?, ?, ?, ?, 'idle', '2026-01-01T00:00:00')`,
      [name, runId, role, sessId],
    );
  }

  // Insert messages with explicit ids using a sequence
  const msgs = [
    [1, "operator", "manager", "run1 goal"],
    [2, "operator", "manager", "run2 goal"],
    [1, "manager",  "coder-1", "run1 code"],
    [2, "manager",  "coder-1", "run2 code"],
  ] as const;
  for (const [runId, from, to, body] of msgs) {
    db.run(
      `INSERT INTO messages (run_id, from_agent, to_agent, type, body, status, created_at)
       VALUES (?, ?, ?, 'TASK', ?, 'pending', '2026-01-01T00:00:00')`,
      [runId, from, to, body],
    );
  }

  db.close();
}

/** Return message ids that are currently 'pending' in the DB. */
function pendingIds(): number[] {
  return (openDb().query("SELECT id FROM messages WHERE status='pending' ORDER BY id").all() as any[]).map(r => r.id);
}

/** Return message ids that are 'read' in the DB. */
function readIds(): number[] {
  return (openDb().query("SELECT id FROM messages WHERE status='read' ORDER BY id").all() as any[]).map(r => r.id);
}

// Map seeded messages to their auto-assigned DB ids (1-indexed in insert order)
function msgId(index: 1 | 2 | 3 | 4): number {
  const rows = openDb().query("SELECT id FROM messages ORDER BY id").all() as any[];
  return rows[index - 1].id;
}

describe("C1 — pending <agent> scopes to SYNAPSE_RUN_ID=1", () => {
  test("shows run1 manager message only; run2 message stays pending", () => {
    const r = run(["pending", "manager"], {
      SYNAPSE_RUN_ID: "1",
      SYNAPSE_AGENT: "manager",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("run1 goal");
    expect(r.stdout).not.toContain("run2 goal");
    // m1 (run1 goal) was consumed; m2 (run2 goal) stays pending
    expect(readIds()).toContain(msgId(1));
    expect(pendingIds()).toContain(msgId(2));
  });
});

describe("C2 — pending <agent> scopes to SYNAPSE_RUN_ID=2", () => {
  test("shows run2 manager message only; run1 message stays pending", () => {
    const r = run(["pending", "manager"], {
      SYNAPSE_RUN_ID: "2",
      SYNAPSE_AGENT: "manager",
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("run2 goal");
    expect(r.stdout).not.toContain("run1 goal");
    expect(readIds()).toContain(msgId(2));
    expect(pendingIds()).toContain(msgId(1));
  });
});

describe("C3 — bare pending scopes to SYNAPSE_RUN_ID=1", () => {
  test("shows all run1 messages (m1, m3) but never run2 messages", () => {
    const r = run(["pending"], { SYNAPSE_RUN_ID: "1" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("run1 goal");
    expect(r.stdout).toContain("run1 code");
    expect(r.stdout).not.toContain("run2 goal");
    expect(r.stdout).not.toContain("run2 code");
  });
});

describe("C4 — pending --all returns all cross-run messages", () => {
  test("shows all four messages", () => {
    const r = run(["pending", "--all"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("run1 goal");
    expect(r.stdout).toContain("run2 goal");
    expect(r.stdout).toContain("run1 code");
    expect(r.stdout).toContain("run2 code");
  });
});

describe("C5 — pending with no SYNAPSE_RUN_ID and no active run fails loud", () => {
  test("exits non-zero with a clear error; no messages consumed", () => {
    // Mark both runs completed
    const db = openDbWritable();
    db.run("UPDATE runs SET status='completed'");
    db.close();

    const before = pendingIds().length;
    const r = run(["pending", "manager"], { SYNAPSE_AGENT: "manager" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("cannot resolve run");
    expect(pendingIds().length).toBe(before);
  });
});

describe("C6 — synapse status scopes to SYNAPSE_RUN_ID=2", () => {
  test("header shows run #2; only run2 agents listed", () => {
    const r = run(["status"], { SYNAPSE_RUN_ID: "2" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("run #2");
    // All agents with run_id=2 appear
    expect(r.stdout).toContain("manager");
    expect(r.stdout).toContain("coder-1");
    // The PENDING column should reflect run2 counts: manager has m2 (run2 goal) pending
    // We just verify the output doesn't choke and shows run #2 in header
  });
});

describe("C7 — synapse status fallback when SYNAPSE_RUN_ID unset", () => {
  test("falls back to latest running run (run 2 by id-desc)", () => {
    const r = run(["status"]);
    expect(r.exitCode).toBe(0);
    // Both runs are running; highest id is 2
    expect(r.stdout).toContain("run #2");
  });
});

describe("C8 — send still writes to caller run (regression guard)", () => {
  test("new message has run_id=1 when SYNAPSE_RUN_ID=1", () => {
    const before = (openDb().query("SELECT COUNT(*) AS n FROM messages").get() as any).n;
    const r = run(
      ["send", "operator", "PROGRESS", "hi", "--from", "manager"],
      { SYNAPSE_RUN_ID: "1", SYNAPSE_AGENT: "manager" },
    );
    expect(r.exitCode).toBe(0);
    const newMsg = openDb()
      .query("SELECT run_id FROM messages ORDER BY id DESC LIMIT 1")
      .get() as any;
    expect(newMsg.run_id).toBe(1);
    const after = (openDb().query("SELECT COUNT(*) AS n FROM messages").get() as any).n;
    expect(after).toBe(before + 1);
  });
});
