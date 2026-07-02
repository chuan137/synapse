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

// Cheap mailbox/roster sweep — idle detection is event-driven, not on this timer.
export const DEFAULT_SWEEP_INTERVAL_MS = 1000;
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
function readTranscriptState(
  sessionId: string,
  debounceMs: number,
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

  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(path).mtimeMs;
  } catch {
    return { status: "unknown", detail: "transcript unreadable" };
  }
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
  const inboundTypes = agent.role === "reviewer" ? ["REVIEW"] : ["TASK", "REVIEW"];
  const placeholders = inboundTypes.map(() => "?").join(", ");
  // For coder role: also exclude TASKs where coder already sent a REVIEW that
  // has no STATUS reply yet — coder is legitimately blocking on the reviewer.
  const coderReviewWaitClause = agent.role === "coder"
    ? `AND NOT EXISTS (
           SELECT 1 FROM messages rev
           WHERE rev.run_id = m.run_id
             AND rev.from_agent = ?
             AND rev.type = 'REVIEW'
             AND rev.ref_id = m.id
             AND NOT EXISTS (
               SELECT 1 FROM messages s
               WHERE s.run_id = m.run_id
                 AND s.from_agent = rev.to_agent
                 AND s.to_agent = rev.from_agent
                 AND s.type = 'STATUS'
                 AND s.ref_id = rev.id
             )
         )`
    : "";
  const row = db
    .query(
      `SELECT m.*
       FROM messages m
       WHERE m.run_id=? AND m.to_agent=? AND m.status IN ('read', 'delivered')
         AND m.type IN (${placeholders})
         AND NOT EXISTS (
           SELECT 1 FROM messages r
           WHERE r.run_id=m.run_id
             AND r.from_agent=?
             AND r.to_agent=m.from_agent
             AND r.type='STATUS'
             AND r.ref_id=m.id
         )
         ${coderReviewWaitClause}
       ORDER BY m.delivered_at DESC, m.id DESC
       LIMIT 1`,
    )
    .get(
      runId,
      agent.window_name,
      ...inboundTypes,
      agent.window_name,
      ...(agent.role === "coder" ? [agent.window_name] : []),
    ) as any;
  return row ?? null;
}

function sendBackReminderBody(agentName: string, msg: any): string {
  return [
    `Harness enforcement: ${msg.type} #${msg.id} from ${msg.from_agent} is still awaiting your STATUS reply.`,
    `Send a STATUS to ${msg.from_agent} referencing msg #${msg.id} before doing anything else:`,
    `synapse send ${msg.from_agent} STATUS "<result: done, blocked, or issues found; include key files/tests>" --ref-id ${msg.id}`,
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

function hasPendingDirectMessageForWindow(
  db: Database,
  windowName: string,
  runId: number,
): boolean {
  const row = db
    .query(
      `SELECT 1 FROM messages WHERE status='pending' AND to_agent=? AND run_id=?
         AND (next_retry_at IS NULL OR next_retry_at <= ?) LIMIT 1`,
    )
    .get(windowName, runId, nowIso());
  return !!row;
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
): AgentState | null {
  let state: AgentState;
  if (agent.session_id && agent.session_id !== "-") {
    state = readTranscriptState(agent.session_id, debounceMs);
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

// Tracks transcript files for activity-driven delivery, combining fs.watch
// events with sweep rechecks so missed watcher events still get noticed.
class FileWatchPool {
  private watchers = new Map<string, ReturnType<typeof fsWatch>>();
  private paths = new Map<string, string>();

  constructor(private onChange: (key: string, source: "sweep" | "watch") => void) {}

  // Idempotent. Fires onChange immediately so callers don't need a separate
  // initial-evaluation step.
  watch(key: string, path: string): void {
    if (this.watchers.has(key)) return;
    this.paths.set(key, path);
    this.watchers.set(
      key,
      fsWatch(path, () => this.onChange(key, "watch")),
    );
    this.onChange(key, "sweep");
  }

  unwatch(key: string): void {
    this.watchers.get(key)?.close();
    this.watchers.delete(key);
    this.paths.delete(key);
  }

  isWatching(key: string): boolean {
    return this.watchers.has(key);
  }

  watchedKeys(): IterableIterator<string> {
    return this.watchers.keys();
  }

  // Sweep's fallback recheck — catches fs.watch events missed via coalesced
  // writes, NFS, etc. Only fires for keys we're actually watching.
  emitOnTranscriptChange(key: string): void {
    if (this.paths.has(key)) this.onChange(key, "sweep");
  }

  closeAll(): void {
    for (const key of [...this.watchers.keys()]) this.unwatch(key);
  }
}

// Event-driven idle detection via FileWatchPool, plus a cheap periodic sweep
// for roster changes and pending mail (things a file watch can't signal).
function runLiveMonitor(
  db: Database,
  tmuxSession: string,
  debounceMs: number,
  sweepMs: number,
  log: (s: string) => void,
  runId?: number,
) {
  const agentStatuses = new Map<string, AgentStatus>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastSeenMtimes = new Map<string, number>();
  let agents: any[] = [];
  let agentsByWindow = new Map<string, any>();
  const sourceLog =
    (source: "sweep" | "watch" | "timer") => (s: string) =>
      log(`[${source}] ${s}`);

  const reloadAgents = () => {
    agents = db
      .query(
        runId !== undefined
          ? "SELECT * FROM agents WHERE status != 'stopped' AND session_id IS NOT NULL AND (run_id=? OR run_id=0)"
          : "SELECT * FROM agents WHERE status != 'stopped' AND session_id IS NOT NULL",
      )
      .all(...(runId !== undefined ? [runId] : [])) as any[];
    agentsByWindow = new Map(agents.map((a) => [a.window_name, a]));
  };

  const refreshAgentStateByWindow = (
    windowName: string,
    eventLog: (s: string) => void,
  ) => {
    const agent = agentsByWindow.get(windowName);
    if (!agent) return null; // deregistered/stopped between event and update
    return refreshAgentState(db, debounceMs, agent, agentStatuses, eventLog, agent.run_id);
  };

  const deliverOrRescheduleInner = (
    windowName: string,
    eventLog: (s: string) => void,
  ) => {
    const agent = agentsByWindow.get(windowName);
    const agentRunId = agent?.run_id ?? (runId ?? 0);
    const agentState = refreshAgentStateByWindow(windowName, eventLog);
    if (agentState?.status === "idle") {
      if (
        agent &&
        nudgeForMissingStatusBeforeMoreWork(db, tmuxSession, agent, agentRunId, eventLog)
      ) {
        nudgeForPendingWork(db, tmuxSession, windowName, agentRunId, eventLog);
      }
    } else if (
      agentState?.remainingDebounceMs !== undefined &&
      agent &&
      (hasPendingDirectMessageForWindow(db, windowName, agentRunId) ||
        !!newestOpenInboundWork(db, agent, agentRunId))
    ) {
      // Agent is still debouncing and has mail waiting — reschedule to re-evaluate when the window expires.
      scheduleDelivery(windowName, agentState.remainingDebounceMs);
    }
  };

  // Deliver pending messages when an agent is idle, or reschedule while it is
  // still debouncing; keep transient DB errors from stopping this path.
  const deliverOrReschedule = (
    windowName: string,
    eventLog: (s: string) => void,
  ) => {
    try {
      deliverOrRescheduleInner(windowName, eventLog);
    } catch (err) {
      eventLog(
        `  ${windowName}: DB error during delivery (transient, will retry): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  const clearDebounceTimer = (windowName: string) => {
    const existing = debounceTimers.get(windowName);
    if (existing) clearTimeout(existing);
    debounceTimers.delete(windowName);
  };

  const scheduleDelivery = (windowName: string, delayMs: number) => {
    debounceTimers.set(
      windowName,
      setTimeout(
        () => {
          debounceTimers.delete(windowName);
          deliverOrReschedule(windowName, sourceLog("timer"));
        },
        Math.max(0, delayMs),
      ),
    );
  };

  // Handles transcript activity from watch/sweep by confirming the transcript
  // mtime changed, then resetting debounce delivery and logging the update.
  const onTranscriptActivity = (windowName: string, source: "sweep" | "watch") => {
    const agent = agentsByWindow.get(windowName);
    const path = agent ? findTranscriptPath(agent.session_id) : undefined;
    if (!path) return;
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      return;
    }
    const prevMtime = lastSeenMtimes.get(windowName);
    if (mtime === prevMtime) return;
    lastSeenMtimes.set(windowName, mtime);
    const fmt = (ms: number | undefined) => (ms === undefined ? "none" : new Date(ms).toISOString());
    sourceLog(source)(
      `  ${windowName}: transcript activity (mtime ${fmt(prevMtime)} -> ${fmt(mtime)})`,
    );
    clearDebounceTimer(windowName);
    deliverOrReschedule(windowName, sourceLog(source));
  };

  const pool = new FileWatchPool(onTranscriptActivity);

  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    if (sweepTimer) clearInterval(sweepTimer);
    for (const t of debounceTimers.values()) clearTimeout(t);
    pool.closeAll();
    log("synapse monitor: stopped");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log(
    `synapse monitor: watching tmux session '${tmuxSession}' via fs.watch (debounce=${debounceMs}ms, mail-sweep=${sweepMs}ms)`,
  );

  let terminalLogged = false;
  const teardownMs = autoTeardownMs();

  // Sweep syncs watcher/timer state with the live roster, cleans up stopped
  // agents, and retries pending nudges for agents already idle.
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
    const trackedNames = new Set([
      ...agentStatuses.keys(),
      ...pool.watchedKeys(),
      ...debounceTimers.keys(),
      ...lastSeenMtimes.keys(),
    ]);
    // Clean up stopped agents
    for (const name of trackedNames) {
      if (liveNames.has(name)) continue;
      pool.unwatch(name);
      agentStatuses.delete(name);
      clearDebounceTimer(name);
      lastSeenMtimes.delete(name);
      sweepLog(`  ${name}: stopped, cleanup`);
    }
    for (const agent of agents) {
      let nudged = false;
      // Nudge agent when mail arrives while it's in idle. 
      const agentState = refreshAgentStateByWindow(agent.window_name, sweepLog);
      if (agentState?.status === "idle") {
        if (nudgeForMissingStatusBeforeMoreWork(db, tmuxSession, agent, agent.run_id, sweepLog)) {
          nudged = nudgeForPendingWork(db, tmuxSession, agent.window_name, agent.run_id, sweepLog);
        }
      }
      // Poll until the transcript appears to start watching
      if (!pool.isWatching(agent.window_name)) {
        const path = findTranscriptPath(agent.session_id);
        if (path) {
          pool.watch(agent.window_name, path);
          sweepLog(`  ${agent.window_name}: watching ${path}`);
        }
      }
      // Recheck for real mtime changes fs.watch may have missed.
      // Skip if we already nudged this agent directly above to avoid double-nudge.
      if (!nudged) pool.emitOnTranscriptChange(agent.window_name);
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
