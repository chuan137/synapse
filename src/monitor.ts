import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  watch as fsWatch,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { dbPath, connect } from "./db";
import { fail, nowIso, DEFAULT_TMUX_SESSION } from "./commands";

// Sweep loop is the primary busy/idle driver (and mailbox/roster checker).
// fs.watch does not trigger delivery directly — it only records a
// high-resolution last-activity timestamp per agent (see FileWatchPool) that
// feeds the sweep's debounce calculation, so debounce timing isn't at the
// mercy of coarse filesystem mtime granularity. Latency to notice an agent
// went idle is bounded by this interval, so it's kept short.
export const DEFAULT_SWEEP_INTERVAL_MS = 250;
export const DEFAULT_DEBOUNCE_MS = 2000;
export const DEFAULT_AUTO_TEARDOWN_MS = 30 * 60 * 1000;

export type DisbandResult = {
  sessionKilled: boolean;
  error?: string;
};

type AgentStatus = "idle" | "busy" | "unknown";
type AgentState = {
  status: AgentStatus;
  detail: string;
  remainingDebounceMs?: number;
};

function autoTeardownMs(): number {
  const raw = process.env.SYNAPSE_AUTO_TEARDOWN_MS;
  if (raw === undefined) return DEFAULT_AUTO_TEARDOWN_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_AUTO_TEARDOWN_MS;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tmuxSessionExists(tmuxSession: string): boolean {
  return Bun.spawnSync(["tmux", "has-session", "-t", tmuxSession]).exitCode === 0;
}

function waitForTmuxSessionGone(tmuxSession: string, timeoutMs = 2000): boolean {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!tmuxSessionExists(tmuxSession)) return true;
    sleepSync(50);
  } while (Date.now() < deadline);
  return !tmuxSessionExists(tmuxSession);
}

function safeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

function monitorLockPath(tmuxSession: string): string {
  return join(dirname(dbPath()), `monitor-${safeFileSegment(tmuxSession)}.pid`);
}

function acquireMonitorLock(tmuxSession: string): () => void {
  const lockPath = monitorLockPath(tmuxSession);
  const pid = String(process.pid);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeFileSync(fd, `${pid}\n`);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          if (readFileSync(lockPath, "utf8").trim() === pid) {
            unlinkSync(lockPath);
          }
        } catch {
          // Already gone or unreadable during process shutdown.
        }
      };
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      let existingPid: number | undefined;
      try {
        existingPid = Number(readFileSync(lockPath, "utf8").trim());
      } catch {
        existingPid = undefined;
      }
      if (existingPid && processIsRunning(existingPid)) {
        fail(
          `monitor already running for tmux session '${tmuxSession}' (pid ${existingPid})`,
        );
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // If another monitor won the race, the next openSync will report it.
      }
    }
  }

  fail(`could not acquire monitor lock for tmux session '${tmuxSession}'`);
}

// Globs $CLAUDE_PROJECTS_DIR for the session's .jsonl instead of
// reconstructing the project-slug encoding — session id is unique enough.
function findTranscriptPath(sessionId: string): string | null {
  const root =
    process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
  if (!existsSync(root)) return null;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = join(root, entry, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Scans backward for the last well-formed assistant entry's stop_reason.
// Tolerates a partially-written final line.
function lastAssistantStopReason(path: string): string | null {
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    return null;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "assistant" && entry.message?.stop_reason) {
      return entry.message.stop_reason as string;
    }
  }
  return null;
}

// Idle is derived from the transcript's latest assistant stop_reason plus file quiet time.
// watcherActivityMs, when supplied, is fs.watch's own wall-clock timestamp of
// the last observed write to this transcript — used alongside the file's
// mtime (whichever is more recent) since some filesystems report mtime at
// coarse resolution, which can make a just-written file look older than it is.
function readTranscriptState(
  sessionId: string,
  debounceMs: number,
  watcherActivityMs?: number,
): AgentState {
  const path = findTranscriptPath(sessionId);
  if (!path) return { status: "unknown", detail: "no transcript found yet" };

  const stopReason = lastAssistantStopReason(path);
  if (!stopReason) {
    return { status: "unknown", detail: "no assistant turn yet" };
  }

  if (stopReason !== "end_turn") {
    return { status: "busy", detail: `stop_reason=${stopReason}` };
  }

  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return { status: "unknown", detail: "transcript unreadable" };
  }
  const lastActivityMs =
    watcherActivityMs !== undefined ? Math.max(watcherActivityMs, mtimeMs) : mtimeMs;
  const ageMs = Date.now() - lastActivityMs;
  if (ageMs < debounceMs) {
    return {
      status: "busy",
      detail: `end_turn, debouncing (${Math.round(ageMs)}ms)`,
      remainingDebounceMs: debounceMs - ageMs,
    };
  }
  return {
    status: "idle",
    detail: `end_turn, quiet for ${Math.round(ageMs)}ms`,
  };
}

function tmuxSendKeys(
  session: string,
  window: string,
  body: string,
): { ok: boolean; error?: string } {
  const target = `${session}:${window}`;
  // -l forces literal text; without it a body that matches a key name (e.g. "Enter") gets
  // consumed as that keypress. Enter is sent separately so it's always a real keypress.
  let result = Bun.spawnSync([
    "tmux",
    "send-keys",
    "-t",
    target,
    "-l",
    "--",
    body,
  ]);
  if (result.exitCode !== 0) {
    const stderr = result.stderr?.toString().trim();
    return {
      ok: false,
      error: stderr || `tmux send-keys exited ${result.exitCode}`,
    };
  }
  result = Bun.spawnSync(["tmux", "send-keys", "-t", target, "Enter"]);
  if (result.exitCode !== 0) {
    const stderr = result.stderr?.toString().trim();
    return {
      ok: false,
      error: stderr || `tmux send-keys (Enter) exited ${result.exitCode}`,
    };
  }
  return { ok: true };
}

function nudgeAgent(
  tmuxSession: string,
  windowName: string,
  prompt: string,
  log: (s: string) => void,
) {
  const res = tmuxSendKeys(tmuxSession, windowName, prompt);
  if (res.ok) {
    log(`  ${windowName}: nudged (${prompt})`);
  } else {
    log(`  ${windowName}: nudge FAILED: ${res.error}`);
  }
}

function newestOpenInboundWork(
  db: Database,
  agent: any,
  runId: number,
): any | null {
  if (agent.role !== "coder" && agent.role !== "reviewer") return null;
  // Both coder and reviewer receive work as TASKs (a review request is
  // also a TASK — coder → reviewer). No per-role type filter needed.
  // For coder role: also exclude TASKs where coder already sent a TASK to
  // reviewer for this task and that TASK has no REPLY yet — coder is
  // legitimately blocking on the reviewer.
  const coderReviewWaitClause = agent.role === "coder"
    ? `AND NOT EXISTS (
           SELECT 1 FROM messages rev
           WHERE rev.run_id = m.run_id
             AND rev.from_agent = ?
             AND rev.type = 'TASK'
             AND rev.to_agent = 'reviewer'
             AND rev.ref_id = m.id
             AND NOT EXISTS (
               SELECT 1 FROM messages s
               WHERE s.run_id = m.run_id
                 AND s.from_agent = rev.to_agent
                 AND s.to_agent = rev.from_agent
                 AND s.type = 'REPLY'
                 AND s.ref_id = rev.id
             )
         )`
    : "";
  const row = db
    .query(
      `SELECT m.*
       FROM messages m
       WHERE m.run_id=? AND m.to_agent=? AND m.status IN ('read', 'delivered')
         AND m.type = 'TASK'
         AND NOT EXISTS (
           SELECT 1 FROM messages r
           WHERE r.run_id=m.run_id
             AND r.from_agent=?
             AND r.to_agent=m.from_agent
             AND r.type='REPLY'
             AND r.ref_id=m.id
         )
         ${coderReviewWaitClause}
       ORDER BY m.delivered_at DESC, m.id DESC
       LIMIT 1`,
    )
    .get(
      runId,
      agent.window_name,
      agent.window_name,
      ...(agent.role === "coder" ? [agent.window_name] : []),
    ) as any;
  return row ?? null;
}

function sendBackReminderBody(agentName: string, msg: any): string {
  return [
    `Harness enforcement: ${msg.type} #${msg.id} from ${msg.from_agent} is still awaiting your REPLY.`,
    `Send a REPLY to ${msg.from_agent} referencing msg #${msg.id} before doing anything else:`,
    `synapse send ${msg.from_agent} REPLY "<result: done, blocked, or issues found; include key files/tests>" --ref-id ${msg.id}`,
    `You are ${agentName}; do not start another task until this send-back is complete.`,
  ].join(" ");
}

function nudgeForMissingStatusBeforeMoreWork(
  db: Database,
  tmuxSession: string,
  agent: any,
  runId: number,
  log: (s: string) => void,
): boolean {
  const open = newestOpenInboundWork(db, agent, runId);
  if (!open) return true;

  nudgeAgent(
    tmuxSession,
    agent.window_name,
    sendBackReminderBody(agent.window_name, open),
    log,
  );

  log(
    `  ${agent.window_name}: send-back required for ${open.type} #${open.id}; held further delivery`,
  );
  return false;
}

function nudgeForPendingWork(
  db: Database,
  tmuxSession: string,
  windowName: string,
  runId: number,
  log: (s: string) => void,
) {
  const row = db
    .query(
      `SELECT 1 FROM messages WHERE status='pending' AND to_agent=? AND run_id=?
       ORDER BY created_at LIMIT 1`,
    )
    .get(windowName, runId) as any;
  if (row) {
    nudgeAgent(tmuxSession, windowName, `synapse pending ${windowName}`, log);
    return true;
  }
  return false;
}

function readTmuxPaneState(
  tmuxSession: string,
  windowName: string,
): AgentState {
  const pane = Bun.spawnSync([
    "tmux",
    "capture-pane",
    "-t",
    `${tmuxSession}:${windowName}`,
    "-p",
  ]);
  const paneText = pane.stdout.toString();
  const isIdle = /[❯$#]\s*$/.test(paneText.trimEnd());
  return { status: isIdle ? "idle" : "busy", detail: "tmux-pane-fallback" };
}

// Reads agent state from transcript (or tmux pane fallback) and persists any transition.
// Returns null if no state source exists or the agent was concurrently stopped — callers skip delivery.
function refreshAgentState(
  db: Database,
  debounceMs: number,
  agent: any,
  agentStatuses: Map<string, AgentStatus>,
  log: (s: string) => void,
  runId: number,
  tmuxSession?: string,
  watcherActivityMs?: number,
): AgentState | null {
  let state: AgentState;
  if (agent.session_id && agent.session_id !== "-") {
    state = readTranscriptState(agent.session_id, debounceMs, watcherActivityMs);
  } else if (tmuxSession) {
    state = readTmuxPaneState(tmuxSession, agent.window_name);
  } else {
    return null;
  }

  const { status, detail } = state;
  const prev = agentStatuses.get(agent.window_name) ?? agent.status;
  agentStatuses.set(agent.window_name, status);
  if (status === "unknown") {
    log(`  ${agent.window_name}: unknown (${detail})`);
    return state;
  }
  if (status !== prev) {
    log(`  ${agent.window_name}: ${prev} -> ${status} (${detail})`);
    // Guarded so a concurrent deregister wins — don't resurrect a stopped row.
    const update = db.run(
      "UPDATE agents SET status=?, last_seen_at=? WHERE window_name=? AND run_id=? AND status != 'stopped'",
      [status, nowIso(), agent.window_name, runId],
    );
    if (update.changes === 0) {
      agentStatuses.delete(agent.window_name);
      log(`  ${agent.window_name}: stopped before readiness update`);
      return null;
    }
  }

  return state;
}

// Kills every non-operator agent window and the tmux session itself. The DB
// (agents/messages/events/runs) is left intact — only the live tmux process
// tree is torn down, never the audit trail (bootstrap-spec.md #9).
export function disbandTeam(
  db: Database,
  tmuxSession: string,
  runId: number,
  log: (s: string) => void,
): DisbandResult {
  const agents = db
    .query(
      "SELECT window_name FROM agents WHERE window_name != 'operator' AND status != 'stopped' AND run_id=?",
    )
    .all(runId) as any[];
  for (const a of agents) {
    Bun.spawnSync([
      "tmux",
      "kill-window",
      "-t",
      `${tmuxSession}:${a.window_name}`,
    ]);
    db.run(
      "UPDATE agents SET status='stopped', last_seen_at=? WHERE window_name=? AND run_id=?",
      [nowIso(), a.window_name, runId],
    );
    log(`  ${a.window_name}: stopped (teardown)`);
  }
  const killSession = Bun.spawnSync(["tmux", "kill-session", "-t", tmuxSession]);
  if (!waitForTmuxSessionGone(tmuxSession)) {
    const stderr = killSession.stderr.toString().trim();
    const error = stderr || `tmux session '${tmuxSession}' still exists after kill-session`;
    log(`synapse monitor: tmux session '${tmuxSession}' still exists after kill-session`);
    return { sessionKilled: false, error };
  }
  db.run("UPDATE runs SET session_killed_at=? WHERE id=?", [nowIso(), runId]);
  log(`synapse monitor: tmux session '${tmuxSession}' killed`);
  return { sessionKilled: true };
}

function terminalRunStatus(db: Database, runId: number): string | null {
  const run = db.query("SELECT status FROM runs WHERE id=?").get(runId) as
    | any
    | undefined;
  if (!run || run.status === "running") return null;
  return run.status;
}

function markOperatorMessagesDelivered(
  db: Database,
  runId: number,
  log: (s: string) => void,
): void {
  const result = db.run(
    "UPDATE messages SET status='delivered', delivered_at=? WHERE to_agent='operator' AND run_id=? AND status='pending'",
    [nowIso(), runId],
  );
  if (result.changes > 0) {
    log(`  operator: ${result.changes} message(s) marked delivered`);
  }
}

function logTerminalRun(
  db: Database,
  tmuxSession: string,
  runId: number,
  log: (s: string) => void,
): void {
  const status = terminalRunStatus(db, runId);
  if (!status) return;
  log(
    `run ${runId} reached terminal state '${status}' — monitor remains active until the session is killed`,
  );
}

// Single synchronous snapshot — evaluate every live agent and nudge ready agents with work.
function pollOnce(
  db: Database,
  tmuxSession: string,
  debounceMs: number,
  log: (s: string) => void,
  runId?: number,
) {
  if (runId !== undefined && terminalRunStatus(db, runId)) {
    logTerminalRun(db, tmuxSession, runId, log);
  }
  const agents = db
    .query(runId !== undefined
      ? "SELECT * FROM agents WHERE status != 'stopped' AND (run_id=? OR run_id=0)"
      : "SELECT * FROM agents WHERE status != 'stopped'"
    )
    .all(...(runId !== undefined ? [runId] : [])) as any[];
  const agentStatuses = new Map<string, AgentStatus>();
  for (const agent of agents) {
    if (agent.window_name === "operator") continue;
    const result = refreshAgentState(
      db,
      debounceMs,
      agent,
      agentStatuses,
      log,
      agent.run_id,
      tmuxSession,
    );
    if (result?.status === "idle") {
      if (nudgeForMissingStatusBeforeMoreWork(db, tmuxSession, agent, agent.run_id, log)) {
        nudgeForPendingWork(db, tmuxSession, agent.window_name, agent.run_id, log);
      }
    }
  }
  if (runId !== undefined) markOperatorMessagesDelivered(db, runId, log);
}

// Tracks per-agent transcript watchers. fs.watch's role is intentionally
// narrow: capture a high-resolution "last write observed" wall-clock
// timestamp per agent so the sweep loop's debounce math isn't limited by
// coarse filesystem mtime granularity. It never triggers evaluation or
// delivery itself — the sweep loop (runLiveMonitor's sweepInner) is the sole
// place busy/idle is decided and agents are nudged, on a fixed cadence.
class FileWatchPool {
  private watchers = new Map<string, ReturnType<typeof fsWatch>>();
  private lastActivityMs = new Map<string, number>();

  // Idempotent. Seeds the activity timestamp from the file's current mtime so
  // debounce math is correct even before the first fs.watch event fires.
  watch(key: string, path: string): void {
    if (this.watchers.has(key)) return;
    try {
      this.lastActivityMs.set(key, statSync(path).mtimeMs);
    } catch {
      this.lastActivityMs.set(key, Date.now());
    }
    this.watchers.set(
      key,
      fsWatch(path, () => this.lastActivityMs.set(key, Date.now())),
    );
  }

  unwatch(key: string): void {
    this.watchers.get(key)?.close();
    this.watchers.delete(key);
    this.lastActivityMs.delete(key);
  }

  isWatching(key: string): boolean {
    return this.watchers.has(key);
  }

  watchedKeys(): IterableIterator<string> {
    return this.watchers.keys();
  }

  // Most recent write time fs.watch has observed for this key, if watched.
  lastActivity(key: string): number | undefined {
    return this.lastActivityMs.get(key);
  }

  closeAll(): void {
    for (const key of [...this.watchers.keys()]) this.unwatch(key);
  }
}

// Sweep loop is the sole driver of busy/idle evaluation and delivery,
// running on a fixed cadence (sweepMs). fs.watch (via FileWatchPool) only
// supplies a precise last-activity timestamp per agent that feeds the
// debounce calculation inside refreshAgentState/readTranscriptState — it
// does not trigger its own evaluation or delivery attempts.
function runLiveMonitor(
  db: Database,
  tmuxSession: string,
  debounceMs: number,
  sweepMs: number,
  log: (s: string) => void,
  runId?: number,
) {
  const agentStatuses = new Map<string, AgentStatus>();
  let agents: any[] = [];
  const sourceLog = (source: "sweep") => (s: string) => log(`[${source}] ${s}`);

  const reloadAgents = () => {
    agents = db
      .query(
        runId !== undefined
          ? "SELECT * FROM agents WHERE status != 'stopped' AND session_id IS NOT NULL AND (run_id=? OR run_id=0)"
          : "SELECT * FROM agents WHERE status != 'stopped' AND session_id IS NOT NULL",
      )
      .all(...(runId !== undefined ? [runId] : [])) as any[];
  };

  const pool = new FileWatchPool();

  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    if (sweepTimer) clearInterval(sweepTimer);
    pool.closeAll();
    log("synapse monitor: stopped");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log(
    `synapse monitor: watching tmux session '${tmuxSession}' via sweep loop (interval=${sweepMs}ms, debounce=${debounceMs}ms); fs.watch supplies activity timestamps only`,
  );

  let terminalLogged = false;
  const teardownMs = autoTeardownMs();

  // Single evaluation pass: syncs watcher state with the live roster, cleans
  // up stopped agents, evaluates every live agent's busy/idle state (fed by
  // fs.watch's last-activity timestamp for debounce precision), and nudges
  // idle agents with pending work. This is the only place delivery happens.
  const sweepInner = () => {
    const sweepLog = sourceLog("sweep");
    if (runId !== undefined && terminalRunStatus(db, runId)) {
      if (!terminalLogged) {
        logTerminalRun(db, tmuxSession, runId, sweepLog);
        terminalLogged = true;
      }
      // Auto-teardown fallback: keep completed runs inspectable, but prevent
      // orphaned sessions from living forever if nobody kills the session.
      const run = db.query("SELECT ended_at, session_killed_at FROM runs WHERE id=?").get(runId) as any;
      if (run?.ended_at && !run.session_killed_at) {
        const endedMs = new Date(run.ended_at + "Z").getTime();
        if (Date.now() - endedMs > teardownMs) {
          sweepLog(`run ${runId}: auto-teardown after ${Math.round(teardownMs / 1000)}s without session kill`);
          disbandTeam(db, tmuxSession, runId, sweepLog);
          return;
        }
      }
    } else {
      terminalLogged = false;
    }
    reloadAgents();
    const liveNames = new Set(agents.map((a) => a.window_name));
    const trackedNames = new Set([...agentStatuses.keys(), ...pool.watchedKeys()]);
    // Clean up stopped agents
    for (const name of trackedNames) {
      if (liveNames.has(name)) continue;
      pool.unwatch(name);
      agentStatuses.delete(name);
      sweepLog(`  ${name}: stopped, cleanup`);
    }
    for (const agent of agents) {
      // Start watching once the transcript appears, so its debounce
      // timestamp is available; harmless no-op once already watching.
      if (!pool.isWatching(agent.window_name)) {
        const path = findTranscriptPath(agent.session_id);
        if (path) {
          pool.watch(agent.window_name, path);
          sweepLog(`  ${agent.window_name}: watching ${path}`);
        }
      }
      const watcherActivityMs = pool.lastActivity(agent.window_name);
      const agentState = refreshAgentState(
        db,
        debounceMs,
        agent,
        agentStatuses,
        sweepLog,
        agent.run_id,
        undefined,
        watcherActivityMs,
      );
      if (agentState?.status === "idle") {
        if (nudgeForMissingStatusBeforeMoreWork(db, tmuxSession, agent, agent.run_id, sweepLog)) {
          nudgeForPendingWork(db, tmuxSession, agent.window_name, agent.run_id, sweepLog);
        }
      }
    }
    if (runId !== undefined) markOperatorMessagesDelivered(db, runId, sweepLog);
  };

  // A transient DB error (e.g. SQLITE_IOERR from WAL/disk pressure) must not
  // kill the monitor; log it and let the next interval tick retry.
  const sweep = () => {
    try {
      sweepInner();
    } catch (err) {
      sourceLog("sweep")(
        `  DB error during sweep (transient, retrying next tick): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  sweep();
  sweepTimer = setInterval(sweep, sweepMs);
}

export function cmdMonitor(flags: Record<string, string>) {
  const tmuxSession = flags["session"] ?? DEFAULT_TMUX_SESSION;
  const sweepMs = flags["interval"]
    ? parseInt(flags["interval"], 10)
    : DEFAULT_SWEEP_INTERVAL_MS;
  const debounceMs = flags["debounce"]
    ? parseInt(flags["debounce"], 10)
    : DEFAULT_DEBOUNCE_MS;
  const once = flags["once"] === "true";
  const runId = flags["run-id"] !== undefined
    ? parseInt(flags["run-id"], 10)
    : undefined;

  const db = connect();
  const log = (s: string) => console.log(`[${nowIso()}] ${s}`);

  if (once) {
    pollOnce(db, tmuxSession, debounceMs, log, runId);
    return;
  }

  const releaseMonitorLock = acquireMonitorLock(tmuxSession);
  process.on("exit", releaseMonitorLock);

  runLiveMonitor(db, tmuxSession, debounceMs, sweepMs, log, runId);
}
