/**
 * Black-box tests for `synapse monitor` (Phase 2: idle detection + delivery).
 *
 * Same subprocess-spawning approach as synapse.test.ts, with two extra
 * fixtures that let the monitor run against fakes instead of a real Claude
 * Code session and a real tmux:
 *
 *  - CLAUDE_PROJECTS_DIR points at a throwaway directory; synthetic jsonl
 *    transcripts are written directly into it, named "<session_id>.jsonl"
 *    inside an arbitrary project subdirectory — this exercises the same
 *    glob-by-session-id lookup the monitor uses against a real
 *    ~/.claude/projects tree, without needing one.
 *  - A fake `tmux` executable is put first on PATH. It appends its argv to
 *    a log file and exits 0 (or, for the failure-path test, exits 1) instead
 *    of touching a real session — so delivery can be asserted on by reading
 *    that log, the same way the monitor's own tmux send-keys call would be
 *    asserted on in a real two-window setup.
 *
 * `--once` makes a single poll pass deterministic and testable instead of
 * having to race a long-lived loop.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SYNAPSE_CLI = join(import.meta.dir, "..", "src", "synapse.ts");

let dir: string;
let dbFile: string;
let projectsRoot: string;
let projectsDir: string;
let fakeBinDir: string;
let tmuxLog: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "synapse-monitor-test-"));
  dbFile = join(dir, "synapse.db");
  // CLAUDE_PROJECTS_DIR is the *parent* of per-project transcript folders,
  // mirroring ~/.claude/projects/<project-slug>/<session-id>.jsonl —
  // findTranscriptPath globs one level down from it.
  projectsRoot = join(dir, "claude-projects");
  projectsDir = join(projectsRoot, "some-project");
  mkdirSync(projectsDir, { recursive: true });

  fakeBinDir = join(dir, "fakebin");
  mkdirSync(fakeBinDir, { recursive: true });
  tmuxLog = join(dir, "tmux.log");
  writeFileSync(
    join(fakeBinDir, "tmux"),
    `#!/bin/sh\necho "$@" >> "${tmuxLog}"\nexit 0\n`
  );
  chmodSync(join(fakeBinDir, "tmux"), 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, SYNAPSE_CLI, ...args], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      HOME: dir,
      SYNAPSE_DB: dbFile,
      SYNAPSE_RUN_ID: "1",
      CLAUDE_PROJECTS_DIR: projectsRoot,
      ...extraEnv,
    },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function runFromRepoRoot(args: string[], extraEnv: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, SYNAPSE_CLI, ...args], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      HOME: dir,
      SYNAPSE_DB: dbFile,
      SYNAPSE_RUN_ID: "1",
      CLAUDE_PROJECTS_DIR: projectsRoot,
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

function writeTranscript(sessionId: string, stopReason: string, ageMs = 0) {
  const path = join(projectsDir, `${sessionId}.jsonl`);
  const entry = {
    type: "assistant",
    message: { role: "assistant", content: [], stop_reason: stopReason },
  };
  writeFileSync(path, JSON.stringify(entry) + "\n");
  if (ageMs > 0) {
    const past = (Date.now() - ageMs) / 1000;
    utimesSync(path, past, past);
  }
}

function tmuxLogContents(): string {
  try {
    return readFileSync(tmuxLog, "utf8");
  } catch {
    return "";
  }
}

describe("monitor: idle detection", () => {
  beforeEach(() => {
    run(["init"]);
    run(["register", "manager", "manager", "sess-manager"]);
    run(["register", "coder-1", "coder", "sess-coder"]);
  });

  test("tool_use keeps the agent busy and updates agents.status", () => {
    writeTranscript("sess-coder", "tool_use");
    const r = run(["monitor", "--once", "--debounce", "0"]);
    expect(r.exitCode).toBe(0);
    const row = openDb().query("SELECT * FROM agents WHERE window_name='coder-1'").get() as any;
    expect(row.status).toBe("busy");
  });

  test("end_turn past the debounce window marks the agent idle", () => {
    writeTranscript("sess-coder", "end_turn", 5000);
    const r = run(["monitor", "--once", "--debounce", "100"]);
    expect(r.exitCode).toBe(0);
    const row = openDb().query("SELECT * FROM agents WHERE window_name='coder-1'").get() as any;
    expect(row.status).toBe("idle");
  });

  test("end_turn within the debounce window is treated as busy, not idle", () => {
    writeTranscript("sess-coder", "end_turn", 0);
    const r = run(["monitor", "--once", "--debounce", "60000"]);
    expect(r.exitCode).toBe(0);
    const row = openDb().query("SELECT * FROM agents WHERE window_name='coder-1'").get() as any;
    expect(row.status).toBe("busy");
  });

  test("no transcript yet leaves status alone (unknown, not idle)", () => {
    const r = run(["monitor", "--once", "--debounce", "0"]);
    expect(r.exitCode).toBe(0);
    const row = openDb().query("SELECT * FROM agents WHERE window_name='coder-1'").get() as any;
    expect(row.status).toBe("unknown");
  });

  test("a stopped agent is skipped entirely", () => {
    const db = new Database(dbFile);
    db.run("UPDATE agents SET status='stopped' WHERE window_name='coder-1'");
    writeTranscript("sess-coder", "end_turn", 5000);
    run(["monitor", "--once", "--debounce", "100"]);
    const row = openDb().query("SELECT * FROM agents WHERE window_name='coder-1'").get() as any;
    expect(row.status).toBe("stopped");
  });
});

describe("monitor: pull nudges", () => {
  beforeEach(() => {
    run(["init"]);
    run(["register", "manager", "manager", "sess-manager"]);
    run(["register", "coder-1", "coder", "sess-coder"]);
    run(["send", "coder-1", "TASK", "do the thing", "--from", "manager"]);
  });

  test("nudges the idle agent to run pending without consuming the message", () => {
    writeTranscript("sess-coder", "end_turn", 5000);
    const r = run(["monitor", "--once", "--session", "team", "--debounce", "100"]);
    expect(r.exitCode).toBe(0);

    const log = tmuxLogContents();
    expect(log).toContain("send-keys -t team:coder-1 -l -- synapse pending coder-1");
    expect(log).toContain("send-keys -t team:coder-1 Enter");

    const msg = openDb().query("SELECT * FROM messages WHERE to_agent='coder-1'").get() as any;
    expect(msg.status).toBe("pending");
  });

  test("one agent pending call consumes multiple pending messages", () => {
    run(["send", "coder-1", "INFO", "Enter", "--from", "manager"]);
    writeTranscript("sess-coder", "end_turn", 5000);
    run(["monitor", "--once", "--debounce", "100"]);

    const pull = run(["pending", "coder-1"], { SYNAPSE_AGENT: "coder-1" });
    expect(pull.stdout).toContain("do the thing");
    expect(pull.stdout).toContain("Enter");

    const rows = openDb()
      .query("SELECT status FROM messages WHERE to_agent='coder-1' ORDER BY id")
      .all() as any[];
    expect(rows.map((row) => row.status)).toEqual(["read", "read"]);
  });

  test("does not nudge while the agent is still busy", () => {
    writeTranscript("sess-coder", "tool_use");
    run(["monitor", "--once", "--debounce", "0"]);

    expect(tmuxLogContents()).toBe("");
    const msg = openDb().query("SELECT * FROM messages WHERE to_agent='coder-1'").get() as any;
    expect(msg.status).toBe("pending");
  });

  test("a TASK -> STATUS round trip is pull-based at both hops", () => {
    writeTranscript("sess-coder", "end_turn", 5000);
    let r = run(["monitor", "--once", "--debounce", "100"]);
    expect(r.exitCode).toBe(0);
    expect(tmuxLogContents()).toContain("send-keys -t team:coder-1 -l -- synapse pending coder-1");

    run(["pending", "coder-1"], { SYNAPSE_AGENT: "coder-1" });
    const task = openDb().query("SELECT * FROM messages WHERE to_agent='coder-1'").get() as any;
    expect(task.status).toBe("read");

    writeTranscript("sess-coder", "tool_use");
    run(["monitor", "--once", "--debounce", "0"]);
    run(["send", "manager", "STATUS", "done", "--from", "coder-1", "--ref-id", String(task.id)]);
    writeTranscript("sess-manager", "end_turn", 5000);

    r = run(["monitor", "--once", "--debounce", "100"]);
    expect(r.exitCode).toBe(0);
    expect(tmuxLogContents()).toContain("send-keys -t team:manager -l -- synapse pending manager");

    const status = openDb().query("SELECT * FROM messages WHERE type='STATUS'").get() as any;
    expect(status.status).toBe("pending");
    expect(status.ref_id).toBe(task.id);
  });

  test("holds new work and reminds coder when a read TASK has no STATUS reply", () => {
    writeTranscript("sess-coder", "end_turn", 5000);
    run(["monitor", "--once", "--debounce", "100"]);
    run(["pending", "coder-1"], { SYNAPSE_AGENT: "coder-1" });

    const task = openDb().query("SELECT * FROM messages WHERE to_agent='coder-1' AND type='TASK'").get() as any;
    expect(task.status).toBe("read");

    run(["send", "coder-1", "TASK", "next thing", "--from", "manager"]);
    writeFileSync(tmuxLog, "");
    run(["monitor", "--once", "--debounce", "100"]);

    const log = tmuxLogContents();
    expect(log).toContain("Harness enforcement: TASK #");
    expect(log).not.toContain("send-keys -t team:coder-1 -l -- synapse pending coder-1");

    const harnessRows = openDb()
      .query("SELECT * FROM messages WHERE from_agent='harness'")
      .all() as any[];
    expect(harnessRows.length).toBe(0);

    const next = openDb()
      .query("SELECT * FROM messages WHERE to_agent='coder-1' AND body='next thing'")
      .get() as any;
    expect(next.status).toBe("pending");
  });

  test("legacy delivered rows still count for send-back enforcement", () => {
    const db = new Database(dbFile);
    db.run("UPDATE messages SET status='delivered', delivered_at=datetime('now') WHERE to_agent='coder-1'");
    db.close();

    run(["send", "coder-1", "TASK", "next thing", "--from", "manager"]);
    writeTranscript("sess-coder", "end_turn", 5000);
    run(["monitor", "--once", "--debounce", "100"]);

    const log = tmuxLogContents();
    expect(log).toContain("Harness enforcement: TASK #");
    expect(log).not.toContain("send-keys -t team:coder-1 -l -- synapse pending coder-1");
  });

  test("leaves message pending when the nudge fails", () => {
    writeFileSync(join(fakeBinDir, "tmux"), `#!/bin/sh\necho "no such window" >&2\nexit 1\n`);
    chmodSync(join(fakeBinDir, "tmux"), 0o755);

    writeTranscript("sess-coder", "end_turn", 5000);

    // Single attempt: first failure is immediately terminal.
    const r = run(["monitor", "--once", "--debounce", "100"]);
    expect(r.exitCode).toBe(0);

    const msg1 = openDb().query("SELECT * FROM messages WHERE to_agent='coder-1'").get() as any;
    expect(msg1.status).toBe("pending");
    expect(msg1.retry_count).toBe(0);

    writeFileSync(
      join(fakeBinDir, "tmux"),
      `#!/bin/sh\necho "$@" >> "${tmuxLog}"\nexit 0\n`
    );
    chmodSync(join(fakeBinDir, "tmux"), 0o755);

    run(["monitor", "--once", "--debounce", "100"]);
    const after = openDb().query("SELECT * FROM messages WHERE to_agent='coder-1'").get() as any;
    expect(after.status).toBe("pending");
    expect(tmuxLogContents()).toContain("send-keys -t team:coder-1 -l -- synapse pending coder-1");
  });

  test("one nudge can cover multiple pending messages", () => {
    run(["send", "coder-1", "INFO", "second message", "--from", "manager"]);
    writeTranscript("sess-coder", "end_turn", 5000);
    run(["monitor", "--once", "--debounce", "100"]);

    const log = tmuxLogContents();
    const nudges = log
      .split("\n")
      .filter((line) => line.includes("send-keys -t team:coder-1 -l -- synapse pending coder-1"));
    expect(nudges.length).toBe(1);

    const pending = openDb()
      .query("SELECT * FROM messages WHERE status='pending' AND to_agent='coder-1'")
      .all() as any[];
    expect(pending.length).toBe(2);
  });
});

// --once exercises the snapshot path (deriveIdleStateFromTranscript / evaluateAgentReadiness /
// readiness evaluation) synchronously and deterministically; these tests instead
// run the real long-lived loop (no --once) as a background process to
// exercise the fs.watch + debounce-timer + cheap-sweep machinery in
// runLiveMonitor that --once never touches. Async/real-timer based by
// necessity — fs.watch events and debounce timers don't fire on demand.
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Generous default: these tests wait on real timers (debounce + sweep) in a
// background process, so under heavy contention from the rest of the suite
// spawning subprocesses concurrently, scheduling jitter is expected — the
// thing being tested is "does it eventually deliver", not "how fast".
async function waitFor(check: () => boolean, timeoutMs = 8000, intervalMs = 20): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await sleep(intervalMs);
  }
  if (!check()) throw new Error("waitFor: condition not met within timeout");
}

function spawnLiveMonitor(args: string[]) {
  return Bun.spawn([process.execPath, SYNAPSE_CLI, "monitor", ...args], {
    cwd: import.meta.dir,
    env: {
      ...process.env,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      SYNAPSE_DB: dbFile,
      SYNAPSE_RUN_ID: "1",
      CLAUDE_PROJECTS_DIR: projectsRoot,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

// Drains a Bun.spawn stream into a growable string without blocking the
// caller — fire-and-forget the pump, read accumulated output via .text().
function collectStream(stream: ReadableStream<Uint8Array>) {
  let buf = "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
    }
  })();
  return { text: () => buf };
}

describe("monitor: live event-driven loop (no --once)", () => {
  let proc: ReturnType<typeof spawnLiveMonitor> | undefined;

  beforeEach(() => {
    run(["init"]);
    run(["register", "manager", "manager", "sess-manager"]);
    run(["register", "coder-1", "coder", "sess-coder"]);
    proc = undefined;
  });

  afterEach(async () => {
    if (proc) {
      proc.kill("SIGTERM");
      await proc.exited;
    }
  });

  test("delivers once fs.watch sees end_turn and the debounce window elapses, with no poll loop driving it", async () => {
    // Explicit per-test timeout: this test makes three sequential waitFor
    // calls (each up to 8000ms by default), so bun's 5000ms default test
    // timeout was killing it mid-wait under load — and because fixtures
    // (tmuxLog, dir, ...) are shared `let`s reassigned by the next test's
    // beforeEach, a killed-but-still-running async test body would then read
    // contamination from whichever test was active when it finally resolved
    // (that's what produced the "hello while idle" cross-test bleed seen
    // while debugging this). Giving the test room to finish on its own,
    // comfortably above waitFor's own ceiling, is the actual fix.
    run(["send", "coder-1", "TASK", "do the thing", "--from", "manager"]);
    proc = spawnLiveMonitor(["--debounce", "80", "--interval", "30"]);
    const out = collectStream(proc.stdout);
    await waitFor(() => out.text().includes("watching tmux session"));

    // Transcript doesn't exist until now — the live loop has to notice it
    // appear (via the cheap sweep, since fs.watch needs an existing path)
    // and attach a watcher before it can react to anything.
    writeTranscript("sess-coder", "tool_use");
    await waitFor(() => out.text().includes("watching") && out.text().includes("sess-coder"));
    expect(tmuxLogContents()).toBe(""); // still busy, nothing delivered yet

    writeTranscript("sess-coder", "end_turn", 0);
    await waitFor(() =>
      tmuxLogContents().includes("send-keys -t team:coder-1 -l -- synapse pending coder-1"),
    );

    const msg = openDb().query("SELECT * FROM messages WHERE to_agent='coder-1'").get() as any;
    expect(msg.status).toBe("pending");
    expect(out.text()).toContain("[watch]   coder-1: transcript activity");
  }, 15000);

  test("a message sent while the agent is already idle is still nudged, via the cheap sweep", async () => {
    // No transcript write happens *after* this — a nudge here can
    // only be triggered by the periodic mail sweep re-checking an already-
    // idle agent's mailbox, not by any fs.watch event.
    writeTranscript("sess-coder", "end_turn", 5000);
    proc = spawnLiveMonitor(["--debounce", "80", "--interval", "30"]);
    const out = collectStream(proc.stdout);
    await waitFor(() => out.text().includes("watching tmux session"));

    await waitFor(() => {
      const row = openDb().query("SELECT * FROM agents WHERE window_name='coder-1'").get() as any;
      return row?.status === "idle";
    });

    run(["send", "coder-1", "TASK", "hello while idle", "--from", "manager"]);
    await waitFor(() =>
      tmuxLogContents().includes("send-keys -t team:coder-1 -l -- synapse pending coder-1"),
    );

    const msg = openDb().query("SELECT * FROM messages WHERE to_agent='coder-1'").get() as any;
    expect(msg.status).toBe("pending");
    expect(out.text()).toContain("[sweep]");
  }, 15000);

  test("end_turn with no pending direct mail does not leave a debounce recheck timer", async () => {
    writeTranscript("sess-coder", "end_turn", 0);
    proc = spawnLiveMonitor(["--debounce", "120", "--interval", "5000"]);
    const out = collectStream(proc.stdout);
    await waitFor(() => out.text().includes("watching tmux session"));
    await waitFor(() => out.text().includes("watching") && out.text().includes("sess-coder"));

    await waitFor(() => {
      const row = openDb().query("SELECT * FROM agents WHERE window_name='coder-1'").get() as any;
      return row?.status === "busy";
    });

    // With no queued direct mail, attemptDelivery should not schedule the
    // debounce timer. The sweep interval is intentionally much longer than
    // this sleep, so a transition to idle here would come from a dangling
    // recheck timer rather than the periodic sweep.
    await sleep(250);

    const row = openDb().query("SELECT * FROM agents WHERE window_name='coder-1'").get() as any;
    expect(row.status).toBe("busy");
    expect(tmuxLogContents()).toBe("");
  }, 15000);

  test("a watcher event after an agent is stopped does not revive or deliver to it", async () => {
    run(["send", "coder-1", "TASK", "do not deliver", "--from", "manager"]);
    writeTranscript("sess-coder", "tool_use");
    proc = spawnLiveMonitor(["--debounce", "40", "--interval", "5000"]);
    const out = collectStream(proc.stdout);
    await waitFor(() => out.text().includes("watching tmux session"));
    await waitFor(() => out.text().includes("watching") && out.text().includes("sess-coder"));

    const db = new Database(dbFile);
    db.run("UPDATE agents SET status='stopped' WHERE window_name='coder-1'");
    db.close();

    writeTranscript("sess-coder", "end_turn", 0);
    await sleep(200);

    const row = openDb().query("SELECT * FROM agents WHERE window_name='coder-1'").get() as any;
    const msg = openDb().query("SELECT * FROM messages WHERE to_agent='coder-1'").get() as any;
    expect(row.status).toBe("stopped");
    expect(msg.status).toBe("pending");
    expect(tmuxLogContents()).toBe("");
  }, 15000);

  test("shuts down cleanly on SIGTERM", async () => {
    proc = spawnLiveMonitor(["--debounce", "80", "--interval", "30"]);
    const out = collectStream(proc.stdout);
    await waitFor(() => out.text().includes("watching tmux session"));

    proc.kill("SIGTERM");
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    expect(out.text()).toContain("stopped");
    proc = undefined;
  }, 15000);
});

describe("monitor: live process lock", () => {
  beforeEach(() => {
    run(["init"]);
  });

  test("refuses to start a second live monitor for the same tmux session", () => {
    writeFileSync(join(dir, "monitor-team.pid"), `${process.pid}\n`);

    const r = run(["monitor", "--session", "team", "--interval", "30"]);

    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("monitor already running for tmux session 'team'");
  });

  test("--once does not take the live monitor lock", () => {
    writeFileSync(join(dir, "monitor-team.pid"), `${process.pid}\n`);

    const r = run(["monitor", "--once", "--session", "team"]);

    expect(r.exitCode).toBe(0);
  });
});

// `synapse done` ends the run, but the monitor and tmux team stay alive so
// the operator can inspect, send follow-up messages, and explicitly kill the session.
describe("monitor: terminal run handling", () => {
  function insertRun(status: string): number {
    const db = new Database(dbFile);
    const result = db.run(
      "INSERT INTO runs (session, goal, status) VALUES ('team', 'goal', ?)",
      [status],
    );
    db.close();
    return Number(result.lastInsertRowid);
  }

  beforeEach(() => {
    run(["init"]);
    run(["register", "operator", "operator", null]);
    run(["register", "manager", "manager", "sess-manager"]);
    run(["register", "coder-1", "coder", "sess-coder"]);
  });

  test("--once leaves a still-running team alone", () => {
    const runId = insertRun("running");
    const r = run(["monitor", "--once", "--session", "team", "--run-id", String(runId)]);
    expect(r.exitCode).toBe(0);
    expect(tmuxLogContents()).toBe("");
    const agent = openDb().query("SELECT status FROM agents WHERE window_name='manager'").get() as any;
    expect(agent.status).not.toBe("stopped");
  });

  test("--once leaves the team alive and still nudges messages once the run is terminal", () => {
    const runId = insertRun("completed");
    run(["send", "manager", "INFO", "follow up", "--from", "operator", "--run-id", String(runId)]);
    writeTranscript("sess-manager", "end_turn", 5000);

    const r = run(["monitor", "--once", "--session", "team", "--run-id", String(runId)]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("monitor remains active until the session is killed");
    expect(tmuxLogContents()).toContain("send-keys -t team:manager -l -- synapse pending manager");

    const db = openDb();
    const manager = db.query("SELECT status FROM agents WHERE window_name='manager'").get() as any;
    const coder = db.query("SELECT status FROM agents WHERE window_name='coder-1'").get() as any;
    expect(manager.status).not.toBe("stopped");
    expect(coder.status).not.toBe("stopped");
    const msg = db.query("SELECT status FROM messages WHERE body='follow up'").get() as any;
    expect(msg.status).toBe("pending");
  });

  test("the live loop notices a terminal run and stays alive until signaled", async () => {
    const runId = insertRun("failed");
    const proc = spawnLiveMonitor(["--session", "team", "--run-id", String(runId), "--interval", "30"]);
    const out = collectStream(proc.stdout);
    await waitFor(() => out.text().includes("monitor remains active until the session is killed"));
    expect(proc.exitCode).toBeNull();
    expect(tmuxLogContents()).toBe("");
    proc.kill("SIGTERM");
    expect(await proc.exited).toBe(0);
  }, 15000);
});

// End-to-end `synapse start` against a real task.yml — templates assembled
// into CLAUDE.md, a task-scoped tmux session, manager goal routing, all with the same fake
// tmux used elsewhere in this file so it doesn't touch a real session.
describe("start: full agent launch against task.yml", () => {
  test("uses templates/task.example.yml when no config path is provided", () => {
    writeFileSync(
      join(fakeBinDir, "tmux"),
      `#!/bin/sh\necho "$@" >> "${tmuxLog}"\n[ "$1" = "has-session" ] && exit 1\nexit 0\n`,
    );
    run(["init"]);

    const r = runFromRepoRoot(["start", "--no-monitor"]);
    expect(r.exitCode).toBe(0);

    const db = openDb();
    const runRow = db.query("SELECT * FROM runs").get() as any;
    expect(runRow.session).toMatch(/^[a-z0-9]+-[0-9a-f]+-\d+$/);
    expect(runRow.goal).toBe("");

    const task = db
      .query("SELECT * FROM messages WHERE type='TASK' AND from_agent='operator'")
      .get() as any;
    expect(task).toBeNull();
  }, 15000);

  test("routes an explicit --goal to manager when using the default template", () => {
    writeFileSync(
      join(fakeBinDir, "tmux"),
      `#!/bin/sh\necho "$@" >> "${tmuxLog}"\n[ "$1" = "has-session" ] && exit 1\nexit 0\n`,
    );
    run(["init"]);

    const r = runFromRepoRoot([
      "start",
      "--no-monitor",
      "--goal",
      "Build feature X",
    ]);
    expect(r.exitCode).toBe(0);

    const db = openDb();
    const runRow = db.query("SELECT * FROM runs").get() as any;
    expect(runRow.goal).toBe("Build feature X");

    const task = db
      .query("SELECT * FROM messages WHERE type='TASK' AND from_agent='operator'")
      .get() as any;
    expect(task.to_agent).toBe("manager");
    expect(task.body).toBe("Build feature X");
  }, 15000);

  test("starts monitor without starting a per-run UI", () => {
    writeFileSync(
      join(fakeBinDir, "tmux"),
      `#!/bin/sh\necho "$@" >> "${tmuxLog}"\n[ "$1" = "has-session" ] && exit 1\nexit 0\n`,
    );

    const r = runFromRepoRoot(["start"]);
    expect(r.exitCode).toBe(0);

    const session = (openDb().query("SELECT session FROM runs").get() as any).session;
    const log = tmuxLogContents();
    expect(log).not.toContain(`new-window -t ${session} -n ui`);
    expect(log).not.toContain("ui --port");
    expect(log).toContain(`synapse.ts monitor --session ${session} --run-id 1`);
    expect(log).toContain("monitor.log");
    expect(log).not.toContain("ui.log");
    expect(r.stdout).not.toContain("UI: http://localhost:");
    expect(log).not.toContain(`sweep-${session}.log`);
  }, 15000);

  test("accepts any task template filename and stores the run copy as task.yml", () => {
    writeFileSync(
      join(fakeBinDir, "tmux"),
      `#!/bin/sh\necho "$@" >> "${tmuxLog}"\n[ "$1" = "has-session" ] && exit 1\nexit 0\n`,
    );
    run(["init"]);

    const yaml = join(dir, "team.yaml");
    writeFileSync(
      yaml,
      [
        "synapse_version: 0.1.0",
        "workflow: hub-and-spoke",
        "agents:",
        "  - role: manager",
        "",
      ].join("\n"),
    );

    const r = run(["start", yaml, "--no-monitor"]);
    expect(r.exitCode).toBe(0);
    const session = (openDb().query("SELECT session FROM runs").get() as any).session;
    expect(readFileSync(join(dir, "runs", session, "task.yml"), "utf8")).toContain(
      "run_id: 1",
    );
  }, 15000);

  test("writes CLAUDE.md per agent, creates a task-scoped tmux session, and routes the goal to manager", () => {
    // The shared fake tmux (above) always exits 0, which works for every
    // command this suite uses elsewhere — except `has-session`, where exit
    // code is the actual signal (0 = exists). cmdStart relies on that to
    // detect a stuck/colliding session, so override it here to report "no
    // such session", matching a real fresh run id.
    writeFileSync(
      join(fakeBinDir, "tmux"),
      `#!/bin/sh\necho "$@" >> "${tmuxLog}"\n[ "$1" = "has-session" ] && exit 1\nexit 0\n`,
    );
    run(["init"]);

    const taskName = "feature-x";
    const taskDir = join(dir, "tasks", taskName);
    mkdirSync(taskDir, { recursive: true });
    const yaml = join(taskDir, "task.yml");
    writeFileSync(
      yaml,
      [
        "synapse_version: 0.1.0",
        "workflow: hub-and-spoke",
        'goal: "Build feature X"',
        "agents:",
        "  - role: manager",
        "  - role: coder",
        "    focus: backend",
        "  - role: coder",
        "  - role: reviewer",
        "",
      ].join("\n"),
    );

    const r = run(["start", yaml, "--no-monitor"]);
    expect(r.exitCode).toBe(0);

    const db = openDb();
    const runRow = db.query("SELECT * FROM runs").get() as any;
    expect(runRow.status).toBe("running");
    expect(runRow.goal).toBe("Build feature X");
    expect(runRow.session).toMatch(/^[a-z0-9]+-[0-9a-f]+-\d+$/);

    const tmuxSession = runRow.session;
    const log = tmuxLogContents();
    expect(log).toContain(`new-session -d -s ${tmuxSession}`);
    expect(log).toContain(`rename-window -t ${tmuxSession} monitor`);
    expect(log).toContain(`new-window -t ${tmuxSession} -n manager`);
    expect(log).toContain(`new-window -t ${tmuxSession} -n coder-1`);
    expect(log).toContain(`new-window -t ${tmuxSession} -n coder-2`);
    expect(log).toContain(`new-window -t ${tmuxSession} -n reviewer`);

    const managerAgent = db.query("SELECT * FROM agents WHERE window_name='manager'").get() as any;
    const coderAgent = db.query("SELECT * FROM agents WHERE window_name='coder-1'").get() as any;
    const reviewerAgent = db.query("SELECT * FROM agents WHERE window_name='reviewer'").get() as any;
    expect(managerAgent.role).toBe("manager");
    expect(coderAgent.role).toBe("coder");
    expect(reviewerAgent.role).toBe("reviewer");

    const agentsRoot = join(dir, "agents", tmuxSession);
    const managerMd = readFileSync(join(agentsRoot, "manager", "CLAUDE.md"), "utf8");
    expect(managerMd).toContain("Synapse Team — Shared Protocol");
    expect(managerMd).toContain("Your role: manager");
    expect(managerMd).toContain("Every coder subtask must be reviewed before you count it complete");
    expect(managerMd).toContain("verify the same `ref_id` chain includes");

    const coderMd = readFileSync(join(agentsRoot, "coder-1", "CLAUDE.md"), "utf8");
    expect(coderMd).toContain("Your role: coder");
    expect(coderMd).toContain("backend");
    expect(coderMd).toContain("mandatory even for small or straightforward changes");
    expect(coderMd).toContain("wait for an approving reviewer `STATUS`");

    const secondCoderMd = readFileSync(join(agentsRoot, "coder-2", "CLAUDE.md"), "utf8");
    expect(secondCoderMd).toContain("Your role: coder");

    const reviewerMd = readFileSync(join(agentsRoot, "reviewer", "CLAUDE.md"), "utf8");
    expect(reviewerMd).toContain("Your role: reviewer");
    expect(reviewerMd).toContain("send a short `INFO` summary to `manager`");
    expect(reviewerMd).toContain("Use `INFO`, not");
    expect(reviewerMd).toContain('synapse send manager INFO "Review LGTM');

    const runTask = readFileSync(join(dir, "runs", tmuxSession, "task.yml"), "utf8");
    expect(runTask).toContain("run_id: 1");
    expect(runTask).toContain(`agents_dir: ${agentsRoot}`);

    // Goal routes to manager.
    const task = db
      .query("SELECT * FROM messages WHERE type='TASK' AND from_agent='operator'")
      .get() as any;
    expect(task.to_agent).toBe("manager");
    expect(task.body).toBe("Build feature X");
  }, 15000);
});
