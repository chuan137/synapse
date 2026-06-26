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
      SYNAPSE_DB: dbFile,
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
    run(["register", "planner", "planner", "sess-planner"]);
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

describe("monitor: direct delivery", () => {
  beforeEach(() => {
    run(["init"]);
    run(["register", "planner", "planner", "sess-planner"]);
    run(["register", "coder-1", "coder", "sess-coder"]);
    run(["send", "coder-1", "TASK", "do the thing", "--from", "planner"]);
  });

  test("delivers the pending message via tmux send-keys once the agent is idle", () => {
    writeTranscript("sess-coder", "end_turn", 5000);
    const r = run(["monitor", "--once", "--session", "team", "--debounce", "100"]);
    expect(r.exitCode).toBe(0);

    const log = tmuxLogContents();
    // Body and Enter are sent as two separate send-keys calls (see
    // tmuxSendKeys) — -l forces literal text so the body can't be
    // misread as a tmux key name.
    expect(log).toContain("send-keys -t team:coder-1 -l -- do the thing");
    expect(log).toContain("send-keys -t team:coder-1 Enter");

    const msg = openDb().query("SELECT * FROM messages WHERE to_agent='coder-1'").get() as any;
    expect(msg.status).toBe("delivered");
    expect(msg.delivered_at).toBeTruthy();
  });

  test("a message body that collides with a tmux key name is still sent literally", () => {
    // Regression test: confirmed against a real tmux pane that send-keys
    // without -l swallows a body of exactly "Enter" as a keypress instead
    // of typing it out. beforeEach already queued "do the thing" ahead of
    // it, so deliver in two ticks (oldest-first, one per tick) and check
    // the second delivery.
    run(["send", "coder-1", "INFO", "Enter", "--from", "planner"]);
    writeTranscript("sess-coder", "end_turn", 5000);
    run(["monitor", "--once", "--debounce", "100"]);
    run(["monitor", "--once", "--debounce", "100"]);
    expect(tmuxLogContents()).toContain("send-keys -t team:coder-1 -l -- Enter");
  });

  test("does not deliver while the agent is still busy", () => {
    writeTranscript("sess-coder", "tool_use");
    run(["monitor", "--once", "--debounce", "0"]);

    expect(tmuxLogContents()).toBe("");
    const msg = openDb().query("SELECT * FROM messages WHERE to_agent='coder-1'").get() as any;
    expect(msg.status).toBe("pending");
  });

  test("a real TASK -> STATUS round trip needs no manual send-keys", () => {
    // Mirrors synapse-spec.md Phase 2's acceptance test (two agents, real
    // round trip), with the tmux/transcript layers faked per this file's
    // header. The "agent" side of each delivery is simulated by writing the
    // transcript a real Claude Code session would have produced and, for
    // the reply, by calling `synapse send` the way the coder's CLAUDE.md
    // instructs it to.
    writeTranscript("sess-coder", "end_turn", 5000);
    let r = run(["monitor", "--once", "--debounce", "100"]);
    expect(r.exitCode).toBe(0);
    expect(tmuxLogContents()).toContain("send-keys -t team:coder-1 -l -- do the thing");

    const task = openDb().query("SELECT * FROM messages WHERE to_agent='coder-1'").get() as any;
    expect(task.status).toBe("delivered");

    // coder-1 picks up the task (tool_use), then finishes (end_turn) and
    // reports STATUS back to planner — exactly as section 6.3 specifies.
    writeTranscript("sess-coder", "tool_use");
    run(["monitor", "--once", "--debounce", "0"]);
    run(["send", "planner", "STATUS", "done", "--from", "coder-1", "--ref-id", String(task.id)]);
    writeTranscript("sess-planner", "end_turn", 5000);

    r = run(["monitor", "--once", "--debounce", "100"]);
    expect(r.exitCode).toBe(0);
    expect(tmuxLogContents()).toContain("send-keys -t team:planner -l -- done");

    const status = openDb().query("SELECT * FROM messages WHERE type='STATUS'").get() as any;
    expect(status.status).toBe("delivered");
    expect(status.ref_id).toBe(task.id);
  });

  test("marks the message failed terminally when the tmux window is gone", () => {
    writeFileSync(join(fakeBinDir, "tmux"), `#!/bin/sh\necho "no such window" >&2\nexit 1\n`);
    chmodSync(join(fakeBinDir, "tmux"), 0o755);

    writeTranscript("sess-coder", "end_turn", 5000);
    const r = run(["monitor", "--once", "--debounce", "100"]);
    expect(r.exitCode).toBe(0);

    const msg = openDb().query("SELECT * FROM messages WHERE to_agent='coder-1'").get() as any;
    expect(msg.status).toBe("failed");

    writeFileSync(
      join(fakeBinDir, "tmux"),
      `#!/bin/sh\necho "$@" >> "${tmuxLog}"\nexit 0\n`
    );
    chmodSync(join(fakeBinDir, "tmux"), 0o755);

    run(["monitor", "--once", "--debounce", "100"]);
    const after = openDb().query("SELECT * FROM messages WHERE to_agent='coder-1'").get() as any;
    expect(after.status).toBe("failed");
    expect(tmuxLogContents()).toBe("");
  });

  test("delivers at most one pending message per agent per tick, oldest first", () => {
    run(["send", "coder-1", "INFO", "second message", "--from", "planner"]);
    writeTranscript("sess-coder", "end_turn", 5000);
    run(["monitor", "--once", "--debounce", "100"]);

    const delivered = openDb()
      .query("SELECT * FROM messages WHERE status='delivered' AND to_agent='coder-1'")
      .all() as any[];
    expect(delivered.length).toBe(1);
    expect(delivered[0].body).toBe("do the thing"); // the older one

    const stillPending = openDb()
      .query("SELECT * FROM messages WHERE status='pending' AND to_agent='coder-1'")
      .all() as any[];
    expect(stillPending.length).toBe(1);
    expect(stillPending[0].body).toBe("second message");
  });
});

describe("monitor: broadcast delivery", () => {
  beforeEach(() => {
    run(["init"]);
    run(["register", "planner", "planner", "sess-planner"]);
    run(["register", "coder-1", "coder", "sess-coder-1"]);
    run(["register", "coder-2", "coder", "sess-coder-2"]);
  });

  test("fans out to every other idle agent and marks the single row delivered", () => {
    run(["send", "broadcast", "INFO", "stand down", "--from", "planner"]);
    writeTranscript("sess-coder-1", "end_turn", 5000);
    writeTranscript("sess-coder-2", "end_turn", 5000);
    writeTranscript("sess-planner", "end_turn", 5000);

    const r = run(["monitor", "--once", "--debounce", "100"]);
    expect(r.exitCode).toBe(0);

    const log = tmuxLogContents();
    expect(log).toContain("send-keys -t team:coder-1 -l -- stand down");
    expect(log).toContain("send-keys -t team:coder-2 -l -- stand down");
    // sender is excluded from the fan-out
    expect(log).not.toContain("team:planner");

    const msg = openDb().query("SELECT * FROM messages WHERE to_agent='broadcast'").get() as any;
    expect(msg.status).toBe("delivered");
  });

  test("withholds the broadcast entirely if any recipient is still busy", () => {
    run(["send", "broadcast", "INFO", "stand down", "--from", "planner"]);
    writeTranscript("sess-coder-1", "end_turn", 5000);
    writeTranscript("sess-coder-2", "tool_use"); // still busy

    run(["monitor", "--once", "--debounce", "100"]);

    expect(tmuxLogContents()).toBe("");
    const msg = openDb().query("SELECT * FROM messages WHERE to_agent='broadcast'").get() as any;
    expect(msg.status).toBe("pending");
  });
});

// --once exercises the snapshot path (deriveIdleStateFromTranscript / evaluateAgentReadiness /
// broadcastReadyMessages) synchronously and deterministically; these tests instead
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
    run(["register", "planner", "planner", "sess-planner"]);
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
    run(["send", "coder-1", "TASK", "do the thing", "--from", "planner"]);
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
    // Wait on the DB row (the canonical fact) rather than the tmux log text:
    // delivery order is tmux send-keys *then* the status write, so by the
    // time the row says "delivered" the log is guaranteed to already
    // contain it — waiting on the log instead left a window, under load,
    // where it could read as present a hair before the DB write landed.
    let msg: any;
    await waitFor(() => {
      msg = openDb().query("SELECT * FROM messages WHERE to_agent='coder-1'").get() as any;
      return msg?.status === "delivered";
    });

    expect(msg.status).toBe("delivered");
    expect(tmuxLogContents()).toContain("send-keys -t team:coder-1 -l -- do the thing");
  }, 15000);

  test("a message sent while the agent is already idle is still delivered, via the cheap sweep", async () => {
    // No transcript write happens *after* this — direct delivery here can
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

    run(["send", "coder-1", "TASK", "hello while idle", "--from", "planner"]);
    let msg: any;
    await waitFor(() => {
      msg = openDb().query("SELECT * FROM messages WHERE to_agent='coder-1'").get() as any;
      return msg?.status === "delivered";
    });

    expect(msg.status).toBe("delivered");
    expect(tmuxLogContents()).toContain("hello while idle");
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
    run(["send", "coder-1", "TASK", "do not deliver", "--from", "planner"]);
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
