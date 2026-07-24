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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { parsePlanSteps } from "../src/commands";
import { buildClaudeArgs } from "../src/launch-args";
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

  test("fresh DB has sendback_nudged_at column in agents table", () => {
    run(["init"]);
    const db = openDb();
    const cols = db.query("PRAGMA table_info(agents)").all() as any[];
    const names = cols.map((c) => c.name);
    expect(names).toContain("sendback_nudged_at");
  });

  test("migrates v12 DB by adding sendback_nudged_at column", () => {
    // Build a v12 DB without sendback_nudged_at
    const db12 = openDbWritable();
    db12.exec(`
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        window_name TEXT NOT NULL, run_id INTEGER NOT NULL, role TEXT NOT NULL,
        model TEXT, session_id TEXT,
        status TEXT NOT NULL DEFAULT 'unknown', last_seen_at TEXT,
        context_tokens INTEGER,
        UNIQUE(window_name, run_id)
      );
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'REPLY', ref_id INTEGER, body TEXT NOT NULL,
        title TEXT, options TEXT, status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL,
        run_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT,
        session TEXT NOT NULL, goal TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT, session_killed_at TEXT);
      PRAGMA user_version=12;
    `);
    db12.run("INSERT INTO agents (window_name, run_id, role, status) VALUES ('old-agent', 0, 'operator', 'idle')");
    db12.close();

    const r = run(["init"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("migrated");

    const after = openDb();
    const cols = after.query("PRAGMA table_info(agents)").all() as any[];
    expect(cols.map((c: any) => c.name)).toContain("sendback_nudged_at");
    // Existing rows have NULL
    const row = after.query("SELECT sendback_nudged_at FROM agents WHERE window_name='old-agent'").get() as any;
    expect(row.sendback_nudged_at).toBeNull();
  });

  test("fresh DB has workdir column in runs table", () => {
    run(["init"]);
    const cols = openDb().query("PRAGMA table_info(runs)").all() as any[];
    expect(cols.map((c: any) => c.name)).toContain("workdir");
  });

  test("migrates v15 DB by adding workdir column to runs", () => {
    const db15 = openDbWritable();
    db15.exec(`
      CREATE TABLE agents (id INTEGER PRIMARY KEY AUTOINCREMENT,
        window_name TEXT NOT NULL, run_id INTEGER NOT NULL, role TEXT NOT NULL,
        model TEXT, session_id TEXT, status TEXT NOT NULL DEFAULT 'unknown',
        last_seen_at TEXT, context_tokens INTEGER, sendback_nudged_at TEXT,
        last_notified_at TEXT, UNIQUE(window_name, run_id));
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER, from_agent TEXT NOT NULL, to_agent TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'REPLY', ref_id INTEGER, body TEXT NOT NULL,
        title TEXT, options TEXT, status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')), delivered_at TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0, next_retry_at TEXT,
        review_waived INTEGER, test_required INTEGER);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL, type TEXT NOT NULL, summary TEXT NOT NULL,
        run_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE runs (id INTEGER PRIMARY KEY AUTOINCREMENT,
        session TEXT NOT NULL, goal TEXT, status TEXT NOT NULL DEFAULT 'running',
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        ended_at TEXT, session_killed_at TEXT);
      CREATE TABLE plan_steps (id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL, root_msg_id INTEGER NOT NULL,
        step_index INTEGER NOT NULL, label TEXT NOT NULL,
        completed_at TEXT, update_text TEXT,
        UNIQUE(run_id, root_msg_id, step_index));
      INSERT INTO runs (session, goal, status) VALUES ('t', 'g', 'running');
    `);
    db15.exec(`PRAGMA user_version=15;`);
    db15.close();

    run(["init"]);
    const after = openDb();
    const cols = after.query("PRAGMA table_info(runs)").all() as any[];
    expect(cols.map((c: any) => c.name)).toContain("workdir");
    // Existing rows get NULL workdir
    const row = after.query("SELECT workdir FROM runs WHERE id=1").get() as any;
    expect(row.workdir).toBeNull();
  });
});

describe("workdir stored in runs", () => {
  beforeEach(() => run(["init"]));

  test("runs.workdir is NULL when not set (defaults applied at agent launch, not stored)", () => {
    // synapse start spawns tmux so we can't run it in tests; directly insert a run
    // the way cmdStart does and verify the schema accepts workdir.
    const db = openDbWritable();
    db.run(`INSERT INTO runs (session, goal, workdir, status) VALUES ('t', 'goal', '/tmp/myrepo', 'running')`);
    const row = db.query("SELECT workdir FROM runs WHERE session='t'").get() as any;
    expect(row.workdir).toBe("/tmp/myrepo");
  });

  test("runs.workdir accepts NULL (no --workdir passed)", () => {
    const db = openDbWritable();
    db.run(`INSERT INTO runs (session, goal, workdir, status) VALUES ('t', 'goal', NULL, 'running')`);
    const row = db.query("SELECT workdir FROM runs WHERE session='t'").get() as any;
    expect(row.workdir).toBeNull();
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
  test("queues a message for each valid send type without crashing", () => {
    // REPLY is intentionally excluded: it is not sent via `synapse send`
    // (use `synapse reply`), and the send command rejects it.
    for (const type of ["TASK", "QUESTION", "PROGRESS"]) {
      const r = run(["send", "coder-1", type, `a ${type} message`, "--from", "manager"]);
      expect(r.exitCode).toBe(0);
      // `send` still works for every type, but now nudges toward the intent
      // verb on stderr — so stderr is non-empty by design, not an error.
      expect(r.stderr).not.toContain("ReferenceError");
    }
    const db = openDb();
    const count = (db.query("SELECT COUNT(*) AS n FROM messages").get() as any).n;
    expect(count).toBe(3);
  });

  test("rejects REPLY via `synapse send` and points to `synapse reply`", () => {
    const r = run(["send", "manager", "REPLY", "done", "--from", "coder-1", "--ref-id", "1"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("synapse reply");
    const db = openDb();
    const count = (db.query("SELECT COUNT(*) AS n FROM messages WHERE type='REPLY'").get() as any).n;
    expect(count).toBe(0);
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
    const r = run(["send", "nobody", "TASK", "hi", "--from", "manager"]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("not in agents registry");
    const db = openDb();
    const row = db.query("SELECT * FROM messages WHERE to_agent='nobody'").get() as any;
    expect(row).toBeTruthy();
  });

  test("stores ref_id when --ref-id is passed", () => {
    run(["send", "coder-1", "TASK", "do the thing", "--from", "manager"]);
    const taskId = (openDb().query("SELECT id FROM messages ORDER BY id DESC LIMIT 1").get() as any).id;
    run(["send", "operator", "PROGRESS", "relaying", "--from", "manager", "--ref-id", String(taskId)]);
    const status = openDb()
      .query("SELECT * FROM messages WHERE type='PROGRESS'")
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
      "send", "coder-1", "TASK",
      "完成。src/commands.ts 变更：(1) 新增 import TASK_EXAMPLE_YML from templates；" +
        "(2) cmdStart 在 configPath 等于默认路径且文件不存在时回退到打包内容，自定义路径不存在时仍明确报错。",
      "--from", "manager",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("(1)");
    expect(r.stderr).toContain("line breaks");
    const db = openDb();
    const msg = db.query("SELECT * FROM messages WHERE type='TASK'").get() as any;
    expect(msg).toBeFalsy();
  });

  test("accepts the same content once split across real newlines", () => {
    const r = run([
      "send", "coder-1", "TASK",
      "完成。src/commands.ts 变更：\n" +
        "(1) 新增 import TASK_EXAMPLE_YML from templates\n" +
        "(2) cmdStart 在 configPath 等于默认路径且文件不存在时回退到打包内容",
      "--from", "manager",
    ]);
    expect(r.exitCode).toBe(0);
    const db = openDb();
    const msg = db.query("SELECT * FROM messages WHERE type='TASK'").get() as any;
    expect(msg).toBeTruthy();
  });

  test("does not flag a short body with only one enumeration marker", () => {
    const r = run([
      "send", "coder-1", "TASK", "Approved (1) go ahead",
      "--from", "manager",
    ]);
    expect(r.exitCode).toBe(0);
  });

  test("rejects a long body with circled-digit markers crammed onto one line", () => {
    const r = run([
      "send", "coder-1", "TASK",
      "完成任务，包含以下改动：①修改了配置文件的默认路径读取逻辑；②新增了单元测试覆盖边界情况；③更新了相关文档说明。",
      "--from", "manager",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("line breaks");
  });

  test("rejects broadcast recipients", () => {
    const r = run(["send", "broadcast", "TASK", "hi everyone", "--from", "manager"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("broadcast messages are no longer supported");
    const db = openDb();
    const count = (db.query("SELECT COUNT(*) AS n FROM messages WHERE to_agent='broadcast'").get() as any).n;
    expect(count).toBe(0);
  });

  test("nudges toward the intent verb on stderr but still queues the message", () => {
    const r = run(["send", "coder-1", "TASK", "do it", "--from", "manager"]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain("synapse task");
    const msg = openDb().query("SELECT * FROM messages WHERE type='TASK'").get() as any;
    expect(msg).toBeTruthy();
    expect(msg.body).toBe("do it");
  });
});

// The intent verbs (task/ask/progress/reply) are thin wrappers over the same
// cmdSend path `send` uses, so they inherit its validation. These tests pin the
// per-verb ergonomics: correct type, verb-specific flags, and shared guards.
describe("intent verbs", () => {
  beforeEach(() => {
    run(["init"]);
    run(["register", "manager", "manager", "sess-p"]);
    run(["register", "coder-1", "coder", "sess-c"]);
  });

  test("task queues a TASK with no stderr nudge", () => {
    const r = run(["task", "coder-1", "implement X", "--from", "manager"]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    const msg = openDb().query("SELECT * FROM messages WHERE type='TASK'").get() as any;
    expect(msg.body).toBe("implement X");
    expect(msg.to_agent).toBe("coder-1");
    expect(msg.from_agent).toBe("manager");
  });

  test("task carries --no-review and --test-required onto the row", () => {
    const r = run([
      "task", "coder-1", "implement Y", "--from", "manager",
      "--no-review", "--test-required",
    ]);
    expect(r.exitCode).toBe(0);
    const msg = openDb().query("SELECT * FROM messages WHERE type='TASK'").get() as any;
    expect(msg.review_waived).toBe(1);
    expect(msg.test_required).toBe(1);
  });

  test("ask queues a QUESTION and stores --options as JSON + --title", () => {
    const r = run([
      "ask", "operator", "Approve the plan?", "--from", "manager",
      "--options", "yes,no,revise", "--title", "Plan approval",
    ]);
    expect(r.exitCode).toBe(0);
    const msg = openDb().query("SELECT * FROM messages WHERE type='QUESTION'").get() as any;
    expect(msg.body).toBe("Approve the plan?");
    expect(msg.to_agent).toBe("operator");
    expect(msg.title).toBe("Plan approval");
    expect(JSON.parse(msg.options)).toEqual(["yes", "no", "revise"]);
  });

  test("ask to operator without --options is rejected", () => {
    const r = run(["ask", "operator", "Any thoughts?", "--from", "manager"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--options");
    const msg = openDb().query("SELECT * FROM messages WHERE type='QUESTION'").get() as any;
    expect(msg).toBeFalsy();
  });

  test("question is an alias for ask", () => {
    const r = run([
      "question", "operator", "Ship it?", "--from", "manager",
      "--options", "ship,hold",
    ]);
    expect(r.exitCode).toBe(0);
    const msg = openDb().query("SELECT * FROM messages WHERE type='QUESTION'").get() as any;
    expect(msg.body).toBe("Ship it?");
    expect(JSON.parse(msg.options)).toEqual(["ship", "hold"]);
  });

  test("progress queues a PROGRESS and enforces the direct-to-operator prefix", () => {
    // A coder's direct-to-operator PROGRESS must lead with a lifecycle marker.
    const ok = run(["progress", "operator", "[start] on it", "--from", "coder-1"]);
    expect(ok.exitCode).toBe(0);
    const msg = openDb().query("SELECT * FROM messages WHERE type='PROGRESS'").get() as any;
    expect(msg.body).toBe("[start] on it");

    const bad = run(["progress", "operator", "just chatting", "--from", "coder-1"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("[start]");
  });

  test("verbs read the body from --body-file - (stdin)", () => {
    const result = Bun.spawnSync(
      [process.execPath, SYNAPSE_CLI, "task", "coder-1", "--from", "manager", "--body-file", "-"],
      {
        cwd: import.meta.dir,
        env: { ...process.env, SYNAPSE_DB: dbFile, SYNAPSE_RUN_ID: "1", SYNAPSE_AGENT: undefined },
        stdin: Buffer.from("body from stdin"),
      },
    );
    expect(result.exitCode).toBe(0);
    const msg = openDb().query("SELECT * FROM messages WHERE type='TASK'").get() as any;
    expect(msg.body).toBe("body from stdin");
  });

  test("task inherits the crammed-numbered-list guard from cmdSend", () => {
    const r = run([
      "task", "coder-1",
      "完成任务，包含以下改动：①修改了配置文件的默认路径读取逻辑；②新增了单元测试覆盖边界情况；③更新了相关文档说明。",
      "--from", "manager",
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("line breaks");
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
    expect(r.stdout).toContain("escape hatch");
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
    run(["reply", String(review.id), "LGTM", "--from", "reviewer"]);
    const reviewReply = openDb().query("SELECT ref_id FROM messages WHERE type='REPLY' AND from_agent='reviewer'").get() as any;
    expect(reviewReply.ref_id).toBe(review.id);

    // coder-1 -> manager: final REPLY
    run(["reply", String(subTask.id), "Feature X done", "--from", "coder-1"]);
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

describe("REPLY is not accepted by `synapse send`", () => {
  // Seeds a TASK from `fromAgent` to `toAgent` and returns its message id.
  function seedTask(fromAgent: string, toAgent: string): number {
    const db = openDbWritable();
    const res = db.run(
      "INSERT INTO messages (run_id, from_agent, to_agent, type, body) VALUES (1, ?, ?, 'TASK', 'review please')",
      [fromAgent, toAgent],
    );
    return Number(res.lastInsertRowid);
  }

  beforeEach(() => {
    run(["init"]);
  });

  // REPLY has one entry point — `synapse reply` — which resolves the recipient
  // from the ref-id and cannot misroute. `synapse send` rejects REPLY outright,
  // even when the recipient happens to be correct, so no misroute is possible.
  test("rejects a REPLY sent via `synapse send`, even to the right recipient", () => {
    const id = seedTask("coder-1", "reviewer");
    const r = run(["send", "coder-1", "REPLY", "issues found: x.md", "--ref-id", String(id)], {
      SYNAPSE_AGENT: "reviewer",
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("synapse reply");
    const count = openDb()
      .query("SELECT COUNT(*) AS n FROM messages WHERE type='REPLY'")
      .get() as any;
    expect(count.n).toBe(0);
  });

  test("does not constrain PROGRESS carrying a ref-id", () => {
    const id = seedTask("coder-1", "reviewer");
    const r = run(["send", "manager", "PROGRESS", "LGTM: x.md", "--ref-id", String(id)], {
      SYNAPSE_AGENT: "reviewer",
    });
    expect(r.exitCode).toBe(0);
  });
});

describe("synapse reply (recipient resolved from ref-id)", () => {
  function seedTask(fromAgent: string, toAgent: string): number {
    const db = openDbWritable();
    const res = db.run(
      "INSERT INTO messages (run_id, from_agent, to_agent, type, body) VALUES (1, ?, ?, 'TASK', 'review please')",
      [fromAgent, toAgent],
    );
    return Number(res.lastInsertRowid);
  }

  beforeEach(() => {
    run(["init"]);
  });

  test("routes the reply to the sender of the referenced message", () => {
    const id = seedTask("coder-1", "reviewer");
    const r = run(["reply", String(id), "issues found: x.md"], { SYNAPSE_AGENT: "reviewer" });
    expect(r.exitCode).toBe(0);
    const msg = openDb()
      .query("SELECT from_agent, to_agent, type, ref_id FROM messages WHERE type='REPLY'")
      .get() as any;
    expect(msg.from_agent).toBe("reviewer");
    expect(msg.to_agent).toBe("coder-1"); // never named on the command line
    expect(msg.ref_id).toBe(id);
  });

  test("fails clearly when the ref-id names no message", () => {
    const r = run(["reply", "999", "done"], { SYNAPSE_AGENT: "reviewer" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("no message #999");
  });

  test("rejects a non-numeric ref-id", () => {
    const r = run(["reply", "abc", "done"], { SYNAPSE_AGENT: "reviewer" });
    expect(r.exitCode).not.toBe(0);
  });

  test("pending prints a ready-to-run reply hint for an inbound TASK", () => {
    openDbWritable().run("INSERT INTO runs (session, goal, status) VALUES ('t', 'g', 'running')");
    seedTask("coder-1", "reviewer");
    const r = run(["pending", "reviewer"], { SYNAPSE_AGENT: "reviewer" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(`synapse reply`);
  });
});

describe("buildClaudeArgs (TC1/TC2 — prompt-swallowing regression)", () => {
  // TC1: prompt survives, disallowedTools has no extra entries (no model)
  test("TC1: prompt is a positional arg, not consumed by --disallowedTools", () => {
    const args = buildClaudeArgs("sess-1", undefined, "synapse pending coder-1");
    // '--' must appear and the prompt must follow it
    const sepIdx = args.indexOf("--");
    expect(sepIdx).toBeGreaterThan(-1);
    expect(args[sepIdx + 1]).toBe("synapse pending coder-1");
    // disallowedTools value is exactly the two tools, nothing more
    const dtIdx = args.indexOf("--disallowedTools");
    expect(dtIdx).toBeGreaterThan(-1);
    expect(args[dtIdx + 1]).toBe("AskUserQuestion,EnterPlanMode");
    // prompt words must not appear inside the disallowedTools value
    expect(args[dtIdx + 1]).not.toContain("synapse");
    expect(args[dtIdx + 1]).not.toContain("pending");
    expect(args[dtIdx + 1]).not.toContain("coder-1");
  });

  // TC2: same, with a model flag present
  test("TC2: --model flag present and prompt still survives as positional", () => {
    const args = buildClaudeArgs("sess-2", "sonnet", "synapse pending coder-2");
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe("sonnet");
    const sepIdx = args.indexOf("--");
    expect(sepIdx).toBeGreaterThan(-1);
    expect(args[sepIdx + 1]).toBe("synapse pending coder-2");
    const dtIdx = args.indexOf("--disallowedTools");
    expect(args[dtIdx + 1]).toBe("AskUserQuestion,EnterPlanMode");
  });
});

// Shared setup for the review/gate suites: a run with id 1 (matching the
// SYNAPSE_RUN_ID the `run` helper exports) plus a manager -> coder-1 subtask.
function seedRun(): void {
  openDbWritable().run(
    "INSERT INTO runs (session, goal, status) VALUES ('team-1', 'g', 'running')",
  );
}
function subtaskId(): number {
  return (openDb()
    .query("SELECT id FROM messages WHERE type='TASK' AND from_agent='manager' AND to_agent='coder-1' ORDER BY id LIMIT 1")
    .get() as any).id;
}

describe("reply --handoff review (reviewer close-out)", () => {
  beforeEach(() => {
    run(["init"]);
    seedRun();
  });

  test("writes the canonical review file, replies to the coder with the path, sends NO manager PROGRESS", () => {
    run(["send", "coder-1", "TASK", "build it", "--from", "manager"]);
    const S = subtaskId();
    run(["send", "reviewer", "TASK", "please review", "--from", "coder-1", "--ref-id", String(S)]);
    const R = (openDb().query("SELECT id FROM messages WHERE to_agent='reviewer' AND type='TASK'").get() as any).id;

    const reviewFile = join(dir, "review.md");
    writeFileSync(reviewFile, "## Review\nverdict: LGTM\nissues: none\n");
    const r = run(["reply", String(R), "LGTM", "--handoff", `review:${reviewFile}`], {
      SYNAPSE_AGENT: "reviewer",
    });
    expect(r.exitCode).toBe(0);

    // The doc landed at the canonical, derived path.
    const artifact = join(dir, "artifacts", "run-1", `${R}-review.md`);
    expect(existsSync(artifact)).toBe(true);
    expect(readFileSync(artifact, "utf8")).toContain("verdict: LGTM");

    const db = openDb();
    // Exactly one REPLY, to the coder (recipient resolved, never named), path in body.
    const reply = db.query("SELECT to_agent, ref_id, body FROM messages WHERE type='REPLY' AND from_agent='reviewer'").get() as any;
    expect(reply.to_agent).toBe("coder-1");
    expect(reply.ref_id).toBe(R);
    expect(reply.body).toContain(".synapse/artifacts/run-1/" + R + "-review.md");
    // The manager fan-out was dropped: no reviewer PROGRESS.
    const prog = db.query("SELECT COUNT(*) AS n FROM messages WHERE type='PROGRESS' AND from_agent='reviewer'").get() as any;
    expect(prog.n).toBe(0);
  });

  test("rejects an unknown --handoff kind", () => {
    run(["send", "coder-1", "TASK", "x", "--from", "manager"]);
    const S = subtaskId();
    run(["send", "reviewer", "TASK", "review", "--from", "coder-1", "--ref-id", String(S)]);
    const R = (openDb().query("SELECT id FROM messages WHERE to_agent='reviewer' AND type='TASK'").get() as any).id;
    const f = join(dir, "r.md");
    writeFileSync(f, "x\n");
    const r = run(["reply", String(R), "LGTM", "--handoff", `bogus:${f}`], { SYNAPSE_AGENT: "reviewer" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("kind must be one of");
  });

  test("rejects --handoff with a missing file", () => {
    run(["send", "coder-1", "TASK", "x", "--from", "manager"]);
    const S = subtaskId();
    run(["send", "reviewer", "TASK", "review", "--from", "coder-1", "--ref-id", String(S)]);
    const R = (openDb().query("SELECT id FROM messages WHERE to_agent='reviewer' AND type='TASK'").get() as any).id;
    const r = run(["reply", String(R), "LGTM", "--handoff", `review:${join(dir, "nope.md")}`], { SYNAPSE_AGENT: "reviewer" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("cannot read file");
  });

  test("rejects a malformed --handoff (no kind:path)", () => {
    run(["send", "coder-1", "TASK", "x", "--from", "manager"]);
    const S = subtaskId();
    const r = run(["reply", String(S), "hi", "--handoff", "reviewonly"], { SYNAPSE_AGENT: "coder-1" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("<kind>:<path>");
  });
});

describe("synapse doc (write-only artifact)", () => {
  beforeEach(() => {
    run(["init"]);
    seedRun();
  });

  test("writes the canonical file and sends no message", () => {
    run(["send", "coder-1", "TASK", "build it", "--from", "manager"]);
    const S = subtaskId();
    const before = (openDb().query("SELECT COUNT(*) n FROM messages").get() as any).n;
    const tp = join(dir, "tp.md");
    writeFileSync(tp, "case 1: happy path\n");
    const r = run(["doc", "testplan", String(S), tp], { SYNAPSE_AGENT: "manager" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(".synapse/artifacts/run-1/" + S + "-testplan.md");
    expect(existsSync(join(dir, "artifacts", "run-1", `${S}-testplan.md`))).toBe(true);
    const after = (openDb().query("SELECT COUNT(*) n FROM messages").get() as any).n;
    expect(after).toBe(before);
  });

  test("reads doc content from stdin with -", () => {
    const result = Bun.spawnSync(
      [process.execPath, SYNAPSE_CLI, "doc", "plan", "7", "-"],
      {
        cwd: import.meta.dir,
        env: { ...process.env, SYNAPSE_DB: dbFile, SYNAPSE_RUN_ID: "1", SYNAPSE_AGENT: "manager" },
        stdin: Buffer.from("the plan\n"),
      },
    );
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(dir, "artifacts", "run-1", "7-plan.md"), "utf8")).toContain("the plan");
  });

  test("rejects an unknown kind", () => {
    const f = join(dir, "x.md");
    writeFileSync(f, "x\n");
    const r = run(["doc", "bogus", "1", f], { SYNAPSE_AGENT: "manager" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("kind must be one of");
  });

  test("rejects an empty file", () => {
    const f = join(dir, "empty.md");
    writeFileSync(f, "   \n");
    const r = run(["doc", "spec", "1", f], { SYNAPSE_AGENT: "manager" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("empty");
  });
});

describe("done completion gate", () => {
  beforeEach(() => {
    run(["init"]);
    run(["register", "operator", "operator", null]);
    run(["register", "manager", "manager", "sess-p"]);
    seedRun();
  });

  test("blocks closing while a subtask has no coder REPLY", () => {
    run(["send", "coder-1", "TASK", "build it", "--from", "manager"]);
    const r = run(["done", "1", "--reason", "shipit", "--status", "done"], { SYNAPSE_AGENT: "manager" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("open subtask chain");
    expect(r.stderr).toContain("has not reported done");
    expect((openDb().query("SELECT status FROM runs WHERE id=1").get() as any).status).toBe("running");
  });

  test("blocks closing while a reported subtask is unreviewed", () => {
    run(["send", "coder-1", "TASK", "build it", "--from", "manager"]);
    const S = subtaskId();
    run(["reply", String(S), "done, merged", "--from", "coder-1"]);
    const r = run(["done", "1", "--reason", "shipit", "--status", "done"], { SYNAPSE_AGENT: "manager" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("not reviewed");
  });

  test("--no-review lets a reported subtask close without a reviewer", () => {
    run(["send", "coder-1", "TASK", "trivial", "--from", "manager", "--no-review"]);
    const S = subtaskId();
    run(["reply", String(S), "done", "--from", "coder-1"]);
    const r = run(["done", "1", "--reason", "shipit", "--status", "done"], { SYNAPSE_AGENT: "manager" });
    expect(r.exitCode).toBe(0);
    expect((openDb().query("SELECT status FROM runs WHERE id=1").get() as any).status).toBe("completed");
  });

  test("closes once the chain is reported and reviewed via reply --handoff review:", () => {
    run(["send", "coder-1", "TASK", "build it", "--from", "manager"]);
    const S = subtaskId();
    run(["reply", String(S), "done", "--from", "coder-1"]);
    run(["send", "reviewer", "TASK", "review", "--from", "coder-1", "--ref-id", String(S)]);
    const R = (openDb().query("SELECT id FROM messages WHERE to_agent='reviewer' AND type='TASK'").get() as any).id;
    const cf = join(dir, "rev.md");
    writeFileSync(cf, "LGTM\n");
    // No manager fan-out anymore; the reviewer's REPLY on the review TASK is the
    // reply-pair the gate accepts (hasOpenChains: reviewedByReplyPair).
    run(["reply", String(R), "LGTM", "--handoff", `review:${cf}`], { SYNAPSE_AGENT: "reviewer" });
    const r = run(["done", "1", "--reason", "shipit", "--status", "done"], { SYNAPSE_AGENT: "manager" });
    expect(r.exitCode).toBe(0);
    expect((openDb().query("SELECT status FROM runs WHERE id=1").get() as any).status).toBe("completed");
  });

  test("--force closes past an open chain and logs the override to events", () => {
    run(["send", "coder-1", "TASK", "build it", "--from", "manager"]);
    const r = run(["done", "1", "--status", "done", "--force", "--reason", "abandoning; operator override"], {
      SYNAPSE_AGENT: "manager",
    });
    expect(r.exitCode).toBe(0);
    expect((openDb().query("SELECT status FROM runs WHERE id=1").get() as any).status).toBe("completed");
    const ev = openDb().query("SELECT type, summary FROM events WHERE run_id=1 AND type='decision'").get() as any;
    expect(ev).not.toBeNull();
    expect(ev.summary).toContain("forced done");
  });

  test("--force requires --reason", () => {
    run(["send", "coder-1", "TASK", "build it", "--from", "manager"]);
    const r = run(["done", "1", "--status", "done", "--force"], { SYNAPSE_AGENT: "manager" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("requires --reason");
  });
});

describe("done gate: worktree merge evidence", () => {
  // These run against a real git repo at <dir>/proj so worktreeIssues has
  // something to inspect (projectRoot = dirname(dirname(SYNAPSE_DB))).
  let proj: string;
  let pdb: string;
  const git = (args: string[]) => Bun.spawnSync({ cmd: ["git", "-C", proj, ...args] });
  const prun = (args: string[], env: Record<string, string> = {}) => run(args, { SYNAPSE_DB: pdb, ...env });
  const pquery = (sql: string) => new Database(pdb, { readonly: true }).query(sql).get() as any;

  beforeEach(() => {
    proj = join(dir, "proj");
    mkdirSync(proj, { recursive: true });
    pdb = join(proj, ".synapse", "synapse.db");
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "t@t.dev"]);
    git(["config", "user.name", "t"]);
    writeFileSync(join(proj, "README.md"), "hi\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "init"]);
    prun(["init"]);
    new Database(pdb).run("INSERT INTO runs (session, goal, status) VALUES ('t', 'g', 'running')");
  });

  // Seeds a fully reported + reviewed subtask (DB chain complete) and returns S.
  function reviewedSubtask(): number {
    prun(["send", "coder-1", "TASK", "work", "--from", "manager"]);
    const S = (new Database(pdb, { readonly: true })
      .query("SELECT id FROM messages WHERE to_agent='coder-1' AND type='TASK'").get() as any).id;
    prun(["reply", String(S), "done", "--from", "coder-1"]);
    prun(["send", "reviewer", "TASK", "rev", "--from", "coder-1", "--ref-id", String(S)]);
    const R = (new Database(pdb, { readonly: true })
      .query("SELECT id FROM messages WHERE to_agent='reviewer' AND type='TASK'").get() as any).id;
    prun(["reply", String(R), "LGTM", "--from", "reviewer"], { SYNAPSE_RUN_ID: "1" });
    prun(["send", "manager", "PROGRESS", "LGTM", "--from", "reviewer", "--ref-id", String(S)], { SYNAPSE_RUN_ID: "1" });
    return S;
  }

  test("blocks when a task-<S> branch is unmerged into main", () => {
    const S = reviewedSubtask();
    git(["checkout", "-q", "-b", `task-${S}`]);
    writeFileSync(join(proj, "f.txt"), "x\n");
    git(["add", "f.txt"]);
    git(["commit", "-q", "-m", "wip"]);
    git(["checkout", "-q", "main"]);

    const r = prun(["done", "1", "--reason", "x", "--status", "done"], { SYNAPSE_AGENT: "manager" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain(`task-${S}`);
    expect(r.stderr).toContain("not merged into main");
    expect(pquery("SELECT status FROM runs WHERE id=1").status).toBe("running");
  });

  test("closes once the branch is merged and removed", () => {
    const S = reviewedSubtask();
    git(["checkout", "-q", "-b", `task-${S}`]);
    writeFileSync(join(proj, "f.txt"), "x\n");
    git(["add", "f.txt"]);
    git(["commit", "-q", "-m", "wip"]);
    git(["checkout", "-q", "main"]);
    git(["merge", "-q", "--ff-only", `task-${S}`]);
    git(["branch", "-q", "-D", `task-${S}`]);

    const r = prun(["done", "1", "--reason", "x", "--status", "done"], { SYNAPSE_AGENT: "manager" });
    expect(r.exitCode).toBe(0);
    expect(pquery("SELECT status FROM runs WHERE id=1").status).toBe("completed");
  });

  test("blocks when a leftover worktree dir remains", () => {
    const S = reviewedSubtask();
    mkdirSync(join(proj, ".worktrees", `task-${S}`), { recursive: true });
    const r = prun(["done", "1", "--reason", "x", "--status", "done"], { SYNAPSE_AGENT: "manager" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("not removed");
    expect(pquery("SELECT status FROM runs WHERE id=1").status).toBe("running");
  });

  test("--force overrides a leftover branch and closes the run", () => {
    const S = reviewedSubtask();
    git(["checkout", "-q", "-b", `task-${S}`]);
    writeFileSync(join(proj, "f.txt"), "x\n");
    git(["add", "f.txt"]);
    git(["commit", "-q", "-m", "wip"]);
    git(["checkout", "-q", "main"]);
    const r = prun(["done", "1", "--status", "done", "--force", "--reason", "override"], { SYNAPSE_AGENT: "manager" });
    expect(r.exitCode).toBe(0);
    expect(pquery("SELECT status FROM runs WHERE id=1").status).toBe("completed");
  });
});

describe("parsePlanSteps (unit)", () => {
  test("extracts steps from ## Plan checklist", () => {
    const md = `## Plan\n\n- [ ] Step one\n- [ ] Step two\n- [ ] Step three\n`;
    const steps = parsePlanSteps(md);
    expect(steps).toEqual([
      { index: 1, label: "Step one" },
      { index: 2, label: "Step two" },
      { index: 3, label: "Step three" },
    ]);
  });

  test("stops at the next ## heading", () => {
    const md = `## Plan\n\n- [ ] Only step\n\n## Notes\n\n- [ ] Not a step\n`;
    expect(parsePlanSteps(md)).toHaveLength(1);
  });

  test("returns empty array when ## Plan section is absent", () => {
    expect(parsePlanSteps("## Notes\n\n- [ ] irrelevant\n")).toEqual([]);
  });

  test("accepts already-checked items (- [x]) and counts them", () => {
    const md = `## Plan\n\n- [x] Done already\n- [ ] Not yet\n`;
    const steps = parsePlanSteps(md);
    expect(steps).toHaveLength(2);
    expect(steps[0].label).toBe("Done already");
  });

  test("ignores plain list items without checkbox", () => {
    const md = `## Plan\n\n- regular bullet\n- [ ] real step\n`;
    const steps = parsePlanSteps(md);
    expect(steps).toHaveLength(1);
    expect(steps[0].label).toBe("real step");
  });
});

describe("synapse doc plan (step parsing + DB population)", () => {
  beforeEach(() => {
    run(["init"]);
    seedRun();
  });

  test("populates plan_steps rows from ## Plan checklist", () => {
    const planFile = join(dir, "plan.md");
    writeFileSync(planFile, `## Plan\n\n- [ ] Implement feature\n- [ ] Write tests\n- [ ] Update docs\n`);
    run(["send", "coder-1", "TASK", "build it", "--from", "manager"]);
    const S = subtaskId();
    const r = run(["doc", "plan", String(S), planFile], { SYNAPSE_AGENT: "manager" });
    expect(r.exitCode).toBe(0);
    const rows = openDb().query("SELECT * FROM plan_steps WHERE root_msg_id=? ORDER BY step_index").all(S) as any[];
    expect(rows).toHaveLength(3);
    expect(rows[0].label).toBe("Implement feature");
    expect(rows[1].label).toBe("Write tests");
    expect(rows[2].label).toBe("Update docs");
    expect(rows.every((r: any) => r.completed_at === null)).toBe(true);
  });

  test("emits a warning but still writes the file when ## Plan is absent", () => {
    const planFile = join(dir, "plan.md");
    writeFileSync(planFile, `## Notes\n\nJust some notes.\n`);
    run(["send", "coder-1", "TASK", "build it", "--from", "manager"]);
    const S = subtaskId();
    const r = run(["doc", "plan", String(S), planFile], { SYNAPSE_AGENT: "manager" });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(dir, "artifacts", "run-1", `${S}-plan.md`))).toBe(true);
    const rows = openDb().query("SELECT COUNT(*) n FROM plan_steps WHERE root_msg_id=?").get(S) as any;
    expect(rows.n).toBe(0);
  });
});

describe("synapse step", () => {
  beforeEach(() => {
    run(["init"]);
    seedRun();
  });

  function seedPlan(): number {
    const planFile = join(dir, "plan.md");
    writeFileSync(planFile, `## Plan\n\n- [ ] Step one\n- [ ] Step two\n`);
    run(["send", "coder-1", "TASK", "build it", "--from", "manager"]);
    const S = subtaskId();
    run(["doc", "plan", String(S), planFile], { SYNAPSE_AGENT: "manager" });
    return S;
  }

  test("marks a step done and prints progress", () => {
    const S = seedPlan();
    const r = run(["step", String(S), "1", "Extracted the module"], { SYNAPSE_AGENT: "coder-1" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("step 1/2");
    const row = openDb().query(
      "SELECT * FROM plan_steps WHERE root_msg_id=? AND step_index=1"
    ).get(S) as any;
    expect(row.completed_at).not.toBeNull();
    expect(row.update_text).toBe("Extracted the module");
  });

  test("emits a notification JSON line to stdout", () => {
    const S = seedPlan();
    const r = run(["step", String(S), "2", "Tests passing"], { SYNAPSE_AGENT: "coder-1" });
    expect(r.exitCode).toBe(0);
    const jsonLine = r.stdout.split("\n").find((l: string) => l.startsWith("{"));
    expect(jsonLine).toBeTruthy();
    const n = JSON.parse(jsonLine!);
    expect(n.type).toBe("notification");
    expect(n.message).toContain("step");
    expect(n.message).toContain("Tests passing");
  });

  test("fails when step index does not exist", () => {
    const S = seedPlan();
    const r = run(["step", String(S), "9", "nope"], { SYNAPSE_AGENT: "coder-1" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("no step 9");
  });

  test("fails when plan has no steps (no plan doc written)", () => {
    run(["send", "coder-1", "TASK", "build it", "--from", "manager"]);
    const S = subtaskId();
    const r = run(["step", String(S), "1", "update"], { SYNAPSE_AGENT: "coder-1" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("no step 1");
  });
});

describe("hook-stop notification emit", () => {
  beforeEach(() => {
    run(["init"]);
    run(["register", "manager", "manager", "sess-m"]);
    run(["register", "coder-1", "coder", "sess-c"]);
    seedRun();
  });

  test("emits notification JSON when agent sent messages since last_notified_at", () => {
    // Seed a message from coder-1 in the DB
    run(["send", "manager", "PROGRESS", "[done] finished", "--from", "coder-1"]);
    // hook-stop with no last_notified_at → should emit notification
    const r = run(["hook-stop"], { SYNAPSE_AGENT: "coder-1", SYNAPSE_RUN_ID: "1" });
    expect(r.exitCode).toBe(0);
    const jsonLine = r.stdout.split("\n").find((l: string) => l.startsWith("{"));
    expect(jsonLine).toBeTruthy();
    const n = JSON.parse(jsonLine!);
    expect(n.type).toBe("notification");
    expect(n.message).toContain("PROGRESS");
    expect(n.message).toContain("manager");
  });

  test("does not emit notification when no messages sent since last_notified_at", () => {
    // Set last_notified_at to future so nothing qualifies
    openDbWritable().run(
      "UPDATE agents SET last_notified_at=datetime('now', '+1 hour') WHERE window_name='coder-1'"
    );
    run(["send", "manager", "PROGRESS", "[done] finished", "--from", "coder-1"]);
    const r = run(["hook-stop"], { SYNAPSE_AGENT: "coder-1", SYNAPSE_RUN_ID: "1" });
    expect(r.exitCode).toBe(0);
    const jsonLine = r.stdout.split("\n").find((l: string) => l.startsWith("{"));
    expect(jsonLine).toBeUndefined();
  });

  test("updates last_notified_at after emitting", () => {
    run(["send", "manager", "PROGRESS", "[done] finished", "--from", "coder-1"]);
    const before = (openDb().query(
      "SELECT last_notified_at FROM agents WHERE window_name='coder-1'"
    ).get() as any).last_notified_at;
    expect(before).toBeNull();
    run(["hook-stop"], { SYNAPSE_AGENT: "coder-1", SYNAPSE_RUN_ID: "1" });
    const after = (openDb().query(
      "SELECT last_notified_at FROM agents WHERE window_name='coder-1'"
    ).get() as any).last_notified_at;
    expect(after).not.toBeNull();
  });
});
