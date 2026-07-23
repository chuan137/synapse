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
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
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
    env: { ...process.env, SYNAPSE_DB: dbFile, SYNAPSE_RUN_ID: "1", SYNAPSE_AGENT: undefined, ...extraEnv },
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
    run(["register", "manager", "manager", "sess-p"]);
    run(["register", "coder-1", "coder", "sess-c"]);
  });

  // Regression test: MESSAGE_TYPES was referenced but never defined, so
  // every `synapse send` crashed with a ReferenceError before it could
  // validate or insert anything.
  test("queues a message for each valid type without crashing", () => {
    for (const type of ["TASK", "QUESTION", "PROGRESS", "REPLY"]) {
      const r = run(["send", "coder-1", type, `a ${type} message`, "--from", "manager"]);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
    }
    const db = openDb();
    const count = (db.query("SELECT COUNT(*) AS n FROM messages").get() as any).n;
    expect(count).toBe(4);
  });

  test("rejects an unrecognized type instead of crashing", () => {
    const r = run(["send", "coder-1", "BOGUS", "hi", "--from", "manager"]);
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
    const r = run(["send", "nobody", "REPLY", "hi", "--from", "manager"]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("not in agents registry");
    const db = openDb();
    const row = db.query("SELECT * FROM messages WHERE to_agent='nobody'").get() as any;
    expect(row).toBeTruthy();
  });

  test("stores ref_id when --ref-id is passed", () => {
    run(["send", "coder-1", "TASK", "do the thing", "--from", "manager"]);
    const taskId = (openDb().query("SELECT id FROM messages ORDER BY id DESC LIMIT 1").get() as any).id;
    run(["send", "manager", "REPLY", "done", "--from", "coder-1", "--ref-id", String(taskId)]);
    const status = openDb()
      .query("SELECT * FROM messages WHERE type='REPLY'")
      .get() as any;
    expect(status.ref_id).toBe(taskId);
  });

  test("QUESTION round-trip: stores options as JSON and is retrievable", () => {
    const r = run([
      "send", "operator", "QUESTION", "Approve destructive migration?",
      "--from", "manager",
      "--options", "yes,no,abort",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain("ReferenceError");

    const db = openDb();
    const msg = db.query("SELECT * FROM messages WHERE type='QUESTION'").get() as any;
    expect(msg).toBeTruthy();
    expect(msg.body).toBe("Approve destructive migration?");
    expect(msg.to_agent).toBe("operator");
    expect(msg.from_agent).toBe("manager");

    // options must be stored as a JSON array
    const opts = JSON.parse(msg.options);
    expect(opts).toEqual(["yes", "no", "abort"]);
  });

  test("QUESTION to operator without --options is rejected", () => {
    const r = run([
      "send", "operator", "QUESTION", "Any freeform thoughts?",
      "--from", "manager",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--options");
    const db = openDb();
    const msg = db.query("SELECT * FROM messages WHERE type='QUESTION'").get() as any;
    expect(msg).toBeFalsy();
  });

  test("rejects a long body with an enumerated list crammed onto one line", () => {
    const r = run([
      "send", "operator", "REPLY",
      "完成。src/commands.ts 变更：(1) 新增 import TASK_EXAMPLE_YML from templates；" +
        "(2) cmdStart 在 configPath 等于默认路径且文件不存在时回退到打包内容，自定义路径不存在时仍明确报错。",
      "--from", "manager",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("(1)");
    expect(r.stderr).toContain("line breaks");
    const db = openDb();
    const msg = db.query("SELECT * FROM messages WHERE type='REPLY'").get() as any;
    expect(msg).toBeFalsy();
  });

  test("accepts the same content once split across real newlines", () => {
    const r = run([
      "send", "operator", "REPLY",
      "完成。src/commands.ts 变更：\n" +
        "(1) 新增 import TASK_EXAMPLE_YML from templates\n" +
        "(2) cmdStart 在 configPath 等于默认路径且文件不存在时回退到打包内容",
      "--from", "manager",
    ]);
    expect(r.exitCode).toBe(0);
    const db = openDb();
    const msg = db.query("SELECT * FROM messages WHERE type='REPLY'").get() as any;
    expect(msg).toBeTruthy();
  });

  test("does not flag a short body with only one enumeration marker", () => {
    const r = run([
      "send", "operator", "REPLY", "Approved (1) go ahead",
      "--from", "manager",
    ]);
    expect(r.exitCode).toBe(0);
  });

  test("rejects a long body with circled-digit markers crammed onto one line", () => {
    const r = run([
      "send", "operator", "REPLY",
      "完成任务，包含以下改动：①修改了配置文件的默认路径读取逻辑；②新增了单元测试覆盖边界情况；③更新了相关文档说明。",
      "--from", "manager",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("line breaks");
  });

  test("rejects broadcast recipients", () => {
    const r = run(["send", "broadcast", "REPLY", "hi everyone", "--from", "manager"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("broadcast messages are no longer supported");
    const db = openDb();
    const count = (db.query("SELECT COUNT(*) AS n FROM messages WHERE to_agent='broadcast'").get() as any).n;
    expect(count).toBe(0);
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
    run(["register", "manager", "manager", "sess-p"]);
    run(["register", "coder-1", "coder", "sess-c"]);
    run(["send", "coder-1", "TASK", "hi", "--from", "manager"]);
    const r = run(["status"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("coder-1");
    // header + coder-1 row + manager row
    const lines = r.stdout.trim().split("\n");
    expect(lines.length).toBe(3);
  });
});

describe("pending / deliver", () => {
  beforeEach(() => {
    run(["init"]);
    // Insert a running run with id=1 so pending scoping works (SYNAPSE_RUN_ID=1 default).
    openDbWritable().run("INSERT INTO runs (session, goal, status) VALUES ('team-1', 'test', 'running')");
    run(["register", "manager", "manager", "sess-p"]);
    run(["register", "coder-1", "coder", "sess-c"]);
    run(["send", "coder-1", "TASK", "do the thing", "--from", "manager"]);
  });

  test("operator pending peek shows the queued message without consuming it", () => {
    const r = run(["pending", "coder-1"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("do the thing");
    const msg = openDb().query("SELECT status FROM messages LIMIT 1").get() as any;
    expect(msg.status).toBe("pending");
  });

  test("agent pending consumes all of that agent's queued messages", () => {
    run(["send", "coder-1", "PROGRESS", "second thing", "--from", "manager"]);
    const r = run(["pending", "coder-1"], { SYNAPSE_AGENT: "coder-1" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("do the thing");
    expect(r.stdout).toContain("second thing");
    const rows = openDb().query("SELECT status FROM messages ORDER BY id").all() as any[];
    expect(rows.map((row) => row.status)).toEqual(["read", "read"]);
  });

  test("bare pending consumes the caller's own work when SYNAPSE_AGENT is set", () => {
    const r = run(["pending"], { SYNAPSE_AGENT: "coder-1" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("do the thing");
    const msg = openDb().query("SELECT status FROM messages LIMIT 1").get() as any;
    expect(msg.status).toBe("read");
  });

  test("deliver marks it read and pending no longer lists it", () => {
    const id = (openDb().query("SELECT id FROM messages LIMIT 1").get() as any).id;
    const r = run(["deliver", String(id)]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("marked read");
    const after = run(["pending", "coder-1"]);
    expect(after.stdout).toContain("no pending messages");
  });

  test("deliver on an already-read id fails instead of double-reading", () => {
    const id = (openDb().query("SELECT id FROM messages LIMIT 1").get() as any).id;
    run(["deliver", String(id)]);
    const r = run(["deliver", String(id)]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no pending or delivered message");
  });
});

describe("unknown command", () => {
  test("fails with a usage hint rather than a stack trace", () => {
    run(["init"]);
    const r = run(["bogus-command"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("unknown command");
    expect(r.stderr).toContain("synapse help");
    expect(r.stderr).not.toContain("ReferenceError");
  });
});

describe("help", () => {
  test("bare synapse prints general help", () => {
    const r = run([]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("synapse <command> [args]");
    expect(r.stdout).toContain("Commands:");
    expect(r.stdout).toContain("send");
  });

  test("synapse help prints general help", () => {
    const r = run(["help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Commands:");
    expect(r.stdout).toContain("synapse help [command]");
  });

  test("synapse help send prints command usage", () => {
    const r = run(["help", "send"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage: synapse send <to> <type> <body>");
    expect(r.stdout).toContain("Queue a message");
  });

  test("command --help prints command usage without touching the DB", () => {
    const r = run(["register", "--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage: synapse register <name> <role>");
    expect(r.stderr).toBe("");
  });
});

describe("start", () => {
  test("fails when --goal is missing", () => {
    run(["init"]);
    const r = run(["start", "--no-monitor"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--goal is required");
  });

  test("run folder is named run-N, not the tmux session name", () => {
    run(["init"]);
    // Fake tmux so start doesn't need a real session.
    const fakeBin = join(dir, "fakebin");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, "tmux"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(fakeBin, "tmux"), 0o755);

    run(["start", "--goal", "test goal", "--no-monitor"], { PATH: `${fakeBin}:${process.env.PATH}` });

    const runsDir = join(dir, "artifacts");
    const entries = readdirSync(runsDir);
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatch(/^run-\d+$/);
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
  // Validates the TASK -> REPLY -> TASK(review) -> REPLY chain from spec section 6.3/6.4.
  beforeEach(() => {
    run(["init"]);
    // Insert a running run with id=1 so pending scoping works (SYNAPSE_RUN_ID=1 default).
    openDbWritable().run("INSERT INTO runs (session, goal, status) VALUES ('team-1', 'test', 'running')");
    run(["register", "operator", "operator", null]);
    run(["register", "manager", "manager", "sess-p"]);
    run(["register", "coder-1", "coder", "sess-c"]);
    run(["register", "reviewer", "reviewer", "sess-r"]);
  });

  test("full TASK→REPLY→TASK(review)→REPLY chain stores correct ref_id links", () => {
    // operator -> manager: root TASK
    run(["send", "manager", "TASK", "Build feature X", "--from", "operator"]);
    const rootTask = openDb().query("SELECT id FROM messages WHERE type='TASK' AND from_agent='operator'").get() as any;

    // manager -> coder-1: subtask
    run(["send", "coder-1", "TASK", "Implement X", "--from", "manager", "--ref-id", String(rootTask.id)]);
    const subTask = openDb().query("SELECT id, ref_id FROM messages WHERE type='TASK' AND from_agent='manager'").get() as any;
    expect(subTask.ref_id).toBe(rootTask.id);

    // coder-1 -> reviewer: review TASK
    run(["send", "reviewer", "TASK", "Please review my PR", "--from", "coder-1", "--ref-id", String(subTask.id)]);
    const review = openDb().query("SELECT id, ref_id FROM messages WHERE type='TASK' AND from_agent='coder-1'").get() as any;
    expect(review.ref_id).toBe(subTask.id);

    // reviewer -> coder-1: REPLY on review
    run(["send", "coder-1", "REPLY", "LGTM", "--from", "reviewer", "--ref-id", String(review.id)]);
    const reviewReply = openDb().query("SELECT ref_id FROM messages WHERE type='REPLY' AND from_agent='reviewer'").get() as any;
    expect(reviewReply.ref_id).toBe(review.id);

    // coder-1 -> manager: final REPLY
    run(["send", "manager", "REPLY", "Feature X done", "--from", "coder-1", "--ref-id", String(subTask.id)]);
    const finalReply = openDb().query("SELECT ref_id FROM messages WHERE type='REPLY' AND from_agent='coder-1'").get() as any;
    expect(finalReply.ref_id).toBe(subTask.id);
  });

  test("pending shows all undelivered messages across the chain", () => {
    run(["send", "manager", "TASK", "Do something", "--from", "operator"]);
    run(["send", "coder-1", "TASK", "Subtask", "--from", "manager"]);
    run(["send", "reviewer", "TASK", "Check this", "--from", "coder-1"]);

    const pending = run(["pending"]);
    expect(pending.exitCode).toBe(0);
    // Each message prints 3 lines: header, body, blank line.
    // Header contains the route arrow "→".
    const lines = pending.stdout.split("\n").filter((l) => l.includes("→"));
    expect(lines.length).toBe(3);
  });
});

describe("done", () => {
  // bootstrap-spec.md #8/#13: `synapse done` is the hub agent's sole
  // completion signal — it writes the run's terminal state and sends the
  // final REPLY to operator.
  beforeEach(() => {
    run(["init"]);
    run(["register", "operator", "operator", null]);
    run(["register", "manager", "manager", "sess-p"]);
  });

  function insertRun(): number {
    const db = openDbWritable();
    const result = db.run(
      "INSERT INTO runs (session, goal, status) VALUES ('team-1', 'Build feature X', 'running')",
    );
    db.close();
    return Number(result.lastInsertRowid);
  }

  test("marks the run completed and sends a final REPLY to operator, ref_id defaulted to the root TASK", () => {
    const runId = insertRun();
    run(["send", "manager", "TASK", "Build feature X", "--from", "operator"]);
    const rootTask = openDb()
      .query("SELECT id FROM messages WHERE type='TASK' AND to_agent='manager'")
      .get() as any;

    const r = run(["done", String(runId), "--reason", "All done", "--status", "done"], {
      SYNAPSE_AGENT: "manager",
    });
    expect(r.exitCode).toBe(0);

    const db = openDb();
    const run_ = db.query("SELECT * FROM runs WHERE id=?").get(runId) as any;
    expect(run_.status).toBe("completed");
    expect(run_.ended_at).not.toBeNull();

    const status = db
      .query("SELECT * FROM messages WHERE type='REPLY' AND from_agent='manager' AND to_agent='operator'")
      .get() as any;
    expect(status.body).toBe("All done");
    expect(status.ref_id).toBe(rootTask.id);
  });

  test("--status failed marks the run failed", () => {
    const runId = insertRun();
    const r = run(["done", String(runId), "--reason", "Could not finish", "--status", "failed"], {
      SYNAPSE_AGENT: "manager",
    });
    expect(r.exitCode).toBe(0);
    const run_ = openDb().query("SELECT status FROM runs WHERE id=?").get(runId) as any;
    expect(run_.status).toBe("failed");
  });

  test("an explicit --ref-id overrides the root-TASK default", () => {
    const runId = insertRun();
    run(["send", "manager", "TASK", "Build feature X", "--from", "operator"]);
    const r = run(
      ["done", String(runId), "--reason", "All done", "--status", "done", "--ref-id", "999"],
      { SYNAPSE_AGENT: "manager" },
    );
    expect(r.exitCode).toBe(0);
    const status = openDb()
      .query("SELECT ref_id FROM messages WHERE type='REPLY' AND from_agent='manager'")
      .get() as any;
    expect(status.ref_id).toBe(999);
  });
});
