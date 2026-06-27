/**
 * Black-box tests for the synapse CLI.
 *
 * Each test spawns `bun ../src/synapse.ts <args>` as a real subprocess
 * (exactly how a human or an agent invokes it) against a throwaway SQLite
 * file, then asserts on exit code / stdout / stderr and, where useful, on
 * the resulting DB rows.
 *
 * Why subprocess instead of importing synapse.ts directly: synapse.ts calls
 * main() unconditionally at module load, so importing it would run the CLI
 * against the test runner's own argv. Spawning also means a bug like a bare
 * ReferenceError (module-level typo, undefined const, etc.) shows up the
 * same way it would for a real user: non-zero exit + stack trace on
 * stderr, instead of being silently swallowed.
 *
 * Run with: bun test
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";

const SYNAPSE_CLI = join(import.meta.dir, "..", "src", "synapse.ts");

let dir: string;
let dbFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "synapse-test-"));
  dbFile = join(dir, "synapse.db");
});

// init's migration path backs up the whole data directory (not just the DB
// file) as a *sibling* directory named "<dir>.v<N>.bak-<timestamp>" — so
// cleanup has to look one level up, not just inside `dir`.
function backupDirs(): string[] {
  const parent = dirname(dir);
  const prefix = basename(dir);
  return readdirSync(parent)
    .filter((f) => f.startsWith(`${prefix}.v`) && f.includes(".bak-"))
    .map((f) => join(parent, f));
}

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const b of backupDirs()) rmSync(b, { recursive: true, force: true });
});

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, SYNAPSE_CLI, ...args], {
    cwd: import.meta.dir,
    env: { ...process.env, SYNAPSE_DB: dbFile, ...extraEnv },
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

describe("init", () => {
  test("creates the three tables", () => {
    const r = run(["init"]);
    expect(r.exitCode).toBe(0);
    const db = openDb();
    const names = db
      .query("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row: any) => row.name);
    expect(names).toEqual(expect.arrayContaining(["agents", "messages", "events"]));
  });

  test("stamps the DB with the current schema version", () => {
    const r = run(["init"]);
    expect(r.exitCode).toBe(0);
    const db = openDb();
    const version = (db.query("PRAGMA user_version").get() as any).user_version;
    expect(version).toBeGreaterThan(0);
  });

  test("re-running init on an up-to-date DB is a no-op, no backup created", () => {
    run(["init"]);
    const before = (openDb().query("PRAGMA user_version").get() as any).user_version;
    const r = run(["init"]);
    expect(r.exitCode).toBe(0);
    const after = (openDb().query("PRAGMA user_version").get() as any).user_version;
    expect(after).toBe(before);
    expect(backupDirs().length).toBe(0);
  });

  test("migrates a pre-versioning DB by backing up the whole data folder", () => {
    // Simulate a DB created by a version of the tool that predates the
    // user_version stamp: tables exist, but PRAGMA user_version is unset (0).
    const legacy = openDbWritable();
    legacy.exec(`
      CREATE TABLE agents (window_name TEXT PRIMARY KEY, role TEXT NOT NULL,
        session_id TEXT, status TEXT NOT NULL DEFAULT 'unknown', last_seen_at TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT);
    `);
    legacy.run(
      "INSERT INTO agents (window_name, role, status) VALUES ('legacy-agent', 'coder', 'unknown')"
    );
    legacy.close();

    const r = run(["init"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("found pre-v");
    expect(r.stdout).toContain("moved entire folder");

    // Old data did not bleed into the fresh DB at the canonical path — the
    // data directory was recreated from scratch.
    const fresh = openDb();
    const agents = fresh.query("SELECT * FROM agents").all();
    expect(agents.length).toBe(0);
    const version = (fresh.query("PRAGMA user_version").get() as any).user_version;
    expect(version).toBeGreaterThan(0);

    // But the legacy data is preserved in a backed-up sibling folder, not deleted.
    const backups = backupDirs();
    expect(backups.length).toBe(1);
    const backupDb = new Database(join(backups[0], "synapse.db"), { readonly: true });
    const legacyAgents = backupDb.query("SELECT * FROM agents").all() as any[];
    expect(legacyAgents.length).toBe(1);
    expect(legacyAgents[0].window_name).toBe("legacy-agent");
  });

  test("refuses to init against a DB from a newer schema version", () => {
    run(["init"]);
    const db = openDbWritable();
    db.exec("PRAGMA user_version=99;");
    db.close();

    const r = run(["init"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("newer than this binary supports");
  });
});

describe("register", () => {
  beforeEach(() => run(["init"]));

  test("inserts a new agent", () => {
    const r = run(["register", "coder-1", "coder", "sess-123"]);
    expect(r.exitCode).toBe(0);
    const db = openDb();
    const row = db.query("SELECT * FROM agents WHERE window_name='coder-1'").get() as any;
    expect(row.role).toBe("coder");
    expect(row.session_id).toBe("sess-123");
  });

  test("upserts on a second call instead of duplicating", () => {
    run(["register", "coder-1", "coder", "sess-123"]);
    run(["register", "coder-1", "reviewer", "sess-456"]);
    const db = openDb();
    const rows = db.query("SELECT * FROM agents WHERE window_name='coder-1'").all();
    expect(rows.length).toBe(1);
    expect((rows[0] as any).role).toBe("reviewer");
  });
});

describe("send", () => {
  beforeEach(() => {
    run(["init"]);
    run(["register", "planner", "planner", "sess-p"]);
    run(["register", "coder-1", "coder", "sess-c"]);
  });

  // Regression test: MESSAGE_TYPES was referenced but never defined, so
  // every `synapse send` crashed with a ReferenceError before it could
  // validate or insert anything.
  test("queues a message for each valid type without crashing", () => {
    for (const type of ["TASK", "STATUS", "REVIEW", "ACK", "INFO"]) {
      const r = run(["send", "coder-1", type, `a ${type} message`, "--from", "planner"]);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
    }
    const db = openDb();
    const count = (db.query("SELECT COUNT(*) AS n FROM messages").get() as any).n;
    expect(count).toBe(5);
  });

  test("rejects an unrecognized type instead of crashing", () => {
    const r = run(["send", "coder-1", "BOGUS", "hi", "--from", "planner"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("type must be one of");
    expect(r.stderr).not.toContain("ReferenceError");
  });

  test("requires a sender", () => {
    const r = run(["send", "coder-1", "TASK", "hi"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("missing sender");
  });

  test("warns but still sends to an unregistered recipient", () => {
    const r = run(["send", "nobody", "INFO", "hi", "--from", "planner"]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("not in agents registry");
    const db = openDb();
    const row = db.query("SELECT * FROM messages WHERE to_agent='nobody'").get() as any;
    expect(row).toBeTruthy();
  });

  test("stores ref_id when --ref-id is passed", () => {
    run(["send", "coder-1", "TASK", "do the thing", "--from", "planner"]);
    const taskId = (openDb().query("SELECT id FROM messages ORDER BY id DESC LIMIT 1").get() as any).id;
    run(["send", "planner", "STATUS", "done", "--from", "coder-1", "--ref-id", String(taskId)]);
    const status = openDb()
      .query("SELECT * FROM messages WHERE type='STATUS'")
      .get() as any;
    expect(status.ref_id).toBe(taskId);
  });
});

describe("log", () => {
  beforeEach(() => run(["init"]));

  // Regression test: EVENT_TYPES had the same undefined-name bug as
  // MESSAGE_TYPES above.
  test("records an event for each vocab type without crashing", () => {
    for (const type of ["task_start", "task_end", "decision"]) {
      const r = run(["log", "coder-1", type, `${type} happened`]);
      expect(r.exitCode).toBe(0);
    }
    const db = openDb();
    const count = (db.query("SELECT COUNT(*) AS n FROM events").get() as any).n;
    expect(count).toBe(3);
  });

  test("logs an out-of-vocab type with a warning, doesn't fail", () => {
    const r = run(["log", "coder-1", "weird_type", "something"]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("outside the suggested vocab");
    const db = openDb();
    const row = db.query("SELECT * FROM events WHERE type='weird_type'").get();
    expect(row).toBeTruthy();
  });
});

describe("status", () => {
  test("reports no agents on an empty DB", () => {
    run(["init"]);
    const r = run(["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("no agents registered");
  });

  test("lists a registered agent with its pending count", () => {
    run(["init"]);
    run(["register", "planner", "planner", "sess-p"]);
    run(["register", "coder-1", "coder", "sess-c"]);
    run(["send", "coder-1", "TASK", "hi", "--from", "planner"]);
    const r = run(["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("coder-1");
    // header + coder-1 row + planner row
    const lines = r.stdout.trim().split("\n");
    expect(lines.length).toBe(3);
  });
});

describe("pending / deliver", () => {
  beforeEach(() => {
    run(["init"]);
    run(["register", "planner", "planner", "sess-p"]);
    run(["register", "coder-1", "coder", "sess-c"]);
    run(["send", "coder-1", "TASK", "do the thing", "--from", "planner"]);
  });

  test("pending shows the queued message", () => {
    const r = run(["pending", "coder-1"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("do the thing");
  });

  test("deliver marks it delivered and pending no longer lists it", () => {
    const id = (openDb().query("SELECT id FROM messages LIMIT 1").get() as any).id;
    const r = run(["deliver", String(id)]);
    expect(r.exitCode).toBe(0);
    const after = run(["pending", "coder-1"]);
    expect(after.stdout).toContain("no pending messages");
  });

  test("deliver on an already-delivered id fails instead of double-delivering", () => {
    const id = (openDb().query("SELECT id FROM messages LIMIT 1").get() as any).id;
    run(["deliver", String(id)]);
    const r = run(["deliver", String(id)]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no pending message");
  });
});

describe("unknown command", () => {
  test("fails with a usage hint rather than a stack trace", () => {
    run(["init"]);
    const r = run(["bogus-command"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown command");
  });
});

describe("start — team.yaml parsing", () => {
  // We test the YAML parsing indirectly: pass a malformed config path and
  // check the error, then a valid file but tmux-free (--no-monitor prevents
  // side-effects that require a live tmux session).

  test("fails when config file does not exist", () => {
    run(["init"]);
    const r = run(["start", "/nonexistent/team.yaml", "--no-monitor"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("team config not found");
  });

  test("fails when yaml has no agents", () => {
    run(["init"]);
    const yaml = join(dir, "empty.yaml");
    Bun.write(yaml, "session: team\nagents:\n");
    const r = run(["start", yaml, "--no-monitor"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no agents defined");
  });

  test("fails when yaml is missing session field", () => {
    run(["init"]);
    const yaml = join(dir, "nosession.yaml");
    Bun.write(yaml, "agents:\n  - name: planner\n    role: planner\n    cwd: .\n");
    const r = run(["start", yaml, "--no-monitor"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("missing 'session'");
  });
});

describe("stop", () => {
  beforeEach(() => {
    run(["init"]);
    run(["register", "coder-1", "coder", "sess-c"]);
  });

  test("marks agent stopped in DB", () => {
    // kill-window will fail (no real tmux) but the DB update should still happen
    run(["stop", "coder-1", "--session", "team"]);
    const db = openDb();
    const row = db.query("SELECT status FROM agents WHERE window_name='coder-1'").get() as any;
    expect(row.status).toBe("stopped");
  });

  test("fails for unknown agent", () => {
    const r = run(["stop", "ghost", "--session", "team"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no registered agent");
  });
});

describe("ref_id chain", () => {
  // Validates the TASK -> STATUS -> REVIEW -> STATUS chain from spec section 6.3/6.4.
  beforeEach(() => {
    run(["init"]);
    run(["register", "operator", "operator", null]);
    run(["register", "planner", "planner", "sess-p"]);
    run(["register", "coder-1", "coder", "sess-c"]);
    run(["register", "reviewer", "reviewer", "sess-r"]);
  });

  test("full TASK→STATUS→REVIEW→STATUS chain stores correct ref_id links", () => {
    // operator -> planner: root TASK
    run(["send", "planner", "TASK", "Build feature X", "--from", "operator"]);
    const rootTask = openDb().query("SELECT id FROM messages WHERE type='TASK' AND from_agent='operator'").get() as any;

    // planner -> coder-1: subtask
    run(["send", "coder-1", "TASK", "Implement X", "--from", "planner", "--ref-id", String(rootTask.id)]);
    const subTask = openDb().query("SELECT id, ref_id FROM messages WHERE type='TASK' AND from_agent='planner'").get() as any;
    expect(subTask.ref_id).toBe(rootTask.id);

    // coder-1 -> reviewer: REVIEW
    run(["send", "reviewer", "REVIEW", "Please review my PR", "--from", "coder-1", "--ref-id", String(subTask.id)]);
    const review = openDb().query("SELECT id, ref_id FROM messages WHERE type='REVIEW'").get() as any;
    expect(review.ref_id).toBe(subTask.id);

    // reviewer -> coder-1: STATUS on review
    run(["send", "coder-1", "STATUS", "LGTM", "--from", "reviewer", "--ref-id", String(review.id)]);
    const reviewStatus = openDb().query("SELECT ref_id FROM messages WHERE type='STATUS' AND from_agent='reviewer'").get() as any;
    expect(reviewStatus.ref_id).toBe(review.id);

    // coder-1 -> planner: final STATUS
    run(["send", "planner", "STATUS", "Feature X done", "--from", "coder-1", "--ref-id", String(subTask.id)]);
    const finalStatus = openDb().query("SELECT ref_id FROM messages WHERE type='STATUS' AND from_agent='coder-1'").get() as any;
    expect(finalStatus.ref_id).toBe(subTask.id);
  });

  test("pending shows all undelivered messages across the chain", () => {
    run(["send", "planner", "TASK", "Do something", "--from", "operator"]);
    run(["send", "coder-1", "TASK", "Subtask", "--from", "planner"]);
    run(["send", "reviewer", "REVIEW", "Check this", "--from", "coder-1"]);

    const pending = run(["pending"]);
    expect(pending.exitCode).toBe(0);
    const lines = pending.stdout.split("\n").filter((l) => l.startsWith("["));
    expect(lines.length).toBe(3);
  });
});

