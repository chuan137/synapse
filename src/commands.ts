import { Database } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
  watch as fsWatch,
} from "fs";
import { homedir } from "os";
import { dirname, join, relative, resolve } from "path";
import SHARED_MD from "../templates/shared.md" with { type: "text" };
import ROLE_MANAGER_MD from "../templates/role-manager.md" with { type: "text" };
import ROLE_CODER_MD from "../templates/role-coder.md" with { type: "text" };
import ROLE_REVIEWER_MD from "../templates/role-reviewer.md" with {
  type: "text",
};
import { connect, dbPath, defaultAgentDir, initDb } from "./db";
import { cmdRegister, cmdSend, resolveFrom } from "./mailbox";

const ROLE_TEMPLATES: Record<string, string> = {
  manager: ROLE_MANAGER_MD,
  coder: ROLE_CODER_MD,
  reviewer: ROLE_REVIEWER_MD,
};

export const MESSAGE_TYPES = new Set(["TASK", "STATUS", "REVIEW", "ACK", "INFO", "QUESTION"]);
export const EVENT_TYPES = new Set(["task_start", "task_end", "decision"]);

export const DEFAULT_TMUX_SESSION = "team";
export const DEFAULT_TASK_TEMPLATE = "templates/task.example.yml";
// Cheap mailbox/roster sweep — idle detection is event-driven, not on this timer.
export const DEFAULT_SWEEP_INTERVAL_MS = 1000;
export const DEFAULT_DEBOUNCE_MS = 2000;

export function nowIso(): string {
  return new Date().toISOString().slice(0, 19);
}

export function fail(msg: string): never {
  console.error(`synapse: ${msg}`);
  process.exit(1);
}

export const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
};

export function colorType(t: string): string {
  const color =
    t === "TASK"
      ? c.blue
      : t === "REVIEW"
        ? c.yellow
        : t === "STATUS"
          ? c.green
          : c.cyan;
  return `${color}${t}${c.reset}`;
}

export function cmdInit() {
  initDb();
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

// ---------- monitor ----------

type AgentStatus = "idle" | "busy" | "unknown";
type AgentState = {
  status: AgentStatus;
  detail: string;
  remainingDebounceMs?: number;
};

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

function dispatchDirectMessage(
  db: Database,
  tmuxSession: string,
  windowName: string,
  msg: any,
  log: (s: string) => void,
) {
  const res = tmuxSendKeys(tmuxSession, windowName, msg.body);
  if (res.ok) {
    db.run(
      "UPDATE messages SET status='delivered', delivered_at=? WHERE id=?",
      [nowIso(), msg.id],
    );
    log(
      `  [${msg.id}] ${msg.from_agent} -> ${windowName} (${msg.type}) delivered`,
    );
  } else {
    db.run(
      "UPDATE messages SET status='failed', retry_count=1 WHERE id=?",
      [msg.id],
    );
    log(
      `  [${msg.id}] ${msg.from_agent} -> ${windowName} (${msg.type}) FAILED (terminal): ${res.error}`,
    );
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
  const row = db
    .query(
      `SELECT m.*
       FROM messages m
       WHERE m.run_id=? AND m.to_agent=? AND m.status='delivered'
         AND m.type IN (${placeholders})
         AND NOT EXISTS (
           SELECT 1 FROM messages r
           WHERE r.run_id=m.run_id
             AND r.from_agent=?
             AND r.to_agent=m.from_agent
             AND r.type='STATUS'
             AND r.ref_id=m.id
         )
       ORDER BY m.delivered_at DESC, m.id DESC
       LIMIT 1`,
    )
    .get(runId, agent.window_name, ...inboundTypes, agent.window_name) as any;
  return row ?? null;
}

function sendBackReminderBody(agentName: string, msg: any): string {
  return [
    `Harness enforcement: ${msg.type} #${msg.id} from ${msg.from_agent} is still awaiting your STATUS reply.`,
    "",
    `Please send a STATUS to ${msg.from_agent} referencing msg #${msg.id} before doing anything else:`,
    "",
    `synapse send ${msg.from_agent} STATUS "<result: done, blocked, or issues found; include key files/tests>" --ref-id ${msg.id}`,
    "",
    `You are ${agentName}; do not start another task until this send-back is complete.`,
  ].join("\n");
}

function enforceSendBackBeforeMoreWork(
  db: Database,
  tmuxSession: string,
  agent: any,
  runId: number,
  log: (s: string) => void,
): boolean {
  const open = newestOpenInboundWork(db, agent, runId);
  if (!open) return true;

  const existing = db
    .query(
      `SELECT * FROM messages
       WHERE run_id=? AND from_agent='harness' AND to_agent=?
         AND type='INFO' AND ref_id=?
       ORDER BY id DESC LIMIT 1`,
    )
    .get(runId, agent.window_name, open.id) as any;

  if (existing?.status === "pending") {
    dispatchDirectMessage(db, tmuxSession, agent.window_name, existing, log);
  } else {
    const insert = db.run(
      `INSERT INTO messages (run_id, from_agent, to_agent, type, ref_id, body)
       VALUES (?, 'harness', ?, 'INFO', ?, ?)`,
      [runId, agent.window_name, open.id, sendBackReminderBody(agent.window_name, open)],
    );
    const reminder = db
      .query("SELECT * FROM messages WHERE id=?")
      .get(Number(insert.lastInsertRowid)) as any;
    dispatchDirectMessage(db, tmuxSession, agent.window_name, reminder, log);
  }

  log(
    `  ${agent.window_name}: send-back required for ${open.type} #${open.id}; held further delivery`,
  );
  return false;
}

// Dispatches the oldest pending direct message for windowName, if any.
function dispatchNextDirectMessage(
  db: Database,
  tmuxSession: string,
  windowName: string,
  runId: number,
  log: (s: string) => void,
) {
  const msg = db
    .query(
      `SELECT * FROM messages WHERE status='pending' AND to_agent=? AND run_id=?
       ORDER BY created_at LIMIT 1`,
    )
    .get(windowName, runId) as any;
  if (msg) dispatchDirectMessage(db, tmuxSession, windowName, msg, log);
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

function activeRosterRunId(agents: any[], fallback: number): number {
  return agents.find((a) => a.run_id !== 0)?.run_id ?? fallback;
}

// Broadcasts fire only when every non-sender agent is idle simultaneously —
// a single row can't track partial delivery, so it's all-or-nothing.
function broadcastReadyMessages(
  db: Database,
  tmuxSession: string,
  agents: any[],
  agentStatuses: Map<string, AgentStatus>,
  runId: number,
  log: (s: string) => void,
) {
  const broadcasts = db
    .query(
      `SELECT * FROM messages WHERE status='pending' AND to_agent='broadcast' AND run_id=? ORDER BY created_at`,
    )
    .all(runId) as any[];
  for (const msg of broadcasts) {
    const recipients = agents.filter((a) => a.window_name !== msg.from_agent);
    if (recipients.length === 0) continue;
    const allIdle = recipients.every(
      (a) => agentStatuses.get(a.window_name) === "idle",
    );
    if (!allIdle) continue;
    const blockedRecipient = recipients.find((a) =>
      newestOpenInboundWork(db, a, runId),
    );
    if (blockedRecipient) {
      log(
        `  broadcast[${msg.id}] held: ${blockedRecipient.window_name} must send back before receiving broadcast`,
      );
      continue;
    }
    let allOk = true;
    for (const r of recipients) {
      const res = tmuxSendKeys(tmuxSession, r.window_name, msg.body);
      log(
        `  broadcast[${msg.id}] ${msg.from_agent} -> ${r.window_name}: ${
          res.ok ? "delivered" : "FAILED: " + res.error
        }`,
      );
      if (!res.ok) allOk = false;
    }
    db.run("UPDATE messages SET status=?, delivered_at=? WHERE id=?", [
      allOk ? "delivered" : "failed",
      nowIso(),
      msg.id,
    ]);
  }
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
): void {
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
  Bun.spawnSync(["tmux", "kill-session", "-t", tmuxSession]);
  log(`synapse monitor: tmux session '${tmuxSession}' killed`);
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
    `run ${runId} reached terminal state '${status}' — monitor remains active until UI ACK`,
  );
}

// Single synchronous snapshot — evaluate every live agent, then broadcast if ready.
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
      if (enforceSendBackBeforeMoreWork(db, tmuxSession, agent, agent.run_id, log)) {
        dispatchNextDirectMessage(db, tmuxSession, agent.window_name, agent.run_id, log);
      }
    }
  }
  if (runId !== undefined) markOperatorMessagesDelivered(db, runId, log);
  broadcastReadyMessages(
    db,
    tmuxSession,
    agents,
    agentStatuses,
    runId ?? activeRosterRunId(agents, 0),
    log,
  );
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
        enforceSendBackBeforeMoreWork(db, tmuxSession, agent, agentRunId, eventLog)
      ) {
        dispatchNextDirectMessage(db, tmuxSession, windowName, agentRunId, eventLog);
        broadcastReadyMessages(db, tmuxSession, agents, agentStatuses, agentRunId, eventLog);
      }
    } else if (
      agentState?.remainingDebounceMs !== undefined &&
      hasPendingDirectMessageForWindow(db, windowName, agentRunId)
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

  // Sweep syncs watcher/timer state with the live roster, cleans up stopped
  // agents, retries pending delivery for agents already idle, and broadcasts
  // ready messages.
  const sweepInner = () => {
    const sweepLog = sourceLog("sweep");
    if (runId !== undefined && terminalRunStatus(db, runId)) {
      if (!terminalLogged) {
        logTerminalRun(db, tmuxSession, runId, sweepLog);
        terminalLogged = true;
      }
      // Auto-teardown fallback: if UI never sends ack-run, disband after 60s.
      const run = db.query("SELECT ended_at FROM runs WHERE id=?").get(runId) as any;
      if (run?.ended_at) {
        const endedMs = new Date(run.ended_at + "Z").getTime();
        if (Date.now() - endedMs > 60_000) {
          sweepLog(`run ${runId}: auto-teardown after 60s without UI ACK`);
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
      // Mail can arrive without transcript activity.
      const agentState = refreshAgentStateByWindow(agent.window_name, sweepLog);
      if (agentState?.status === "idle") {
        if (enforceSendBackBeforeMoreWork(db, tmuxSession, agent, agent.run_id, sweepLog)) {
          dispatchNextDirectMessage(db, tmuxSession, agent.window_name, agent.run_id, sweepLog);
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
      pool.emitOnTranscriptChange(agent.window_name);
    }
    if (runId !== undefined) markOperatorMessagesDelivered(db, runId, sweepLog);
    broadcastReadyMessages(
      db,
      tmuxSession,
      agents,
      agentStatuses,
      runId ?? activeRosterRunId(agents, 0),
      sweepLog,
    );
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

// ---------- task.yml / bootstrap ----------

interface AgentConfig {
  name: string;
  role: string;
  // Instance block: free text distinguishing this specific agent from other
  // agents of the same role (e.g. coder-1 vs coder-2).
  focus?: string;
}

interface TaskConfig {
  synapseVersion: string;
  workflow: string;
  goal: string | null;
  agents: AgentConfig[];
}

function appendGeneratedTaskFields(
  taskText: string,
  runId: number,
  agentsDir: string,
): string {
  return `${taskText.trimEnd()}\n\n# --- added by synapse start ---\nrun_id: ${runId}\nagents_dir: ${agentsDir}\n`;
}

function workspaceRelativePath(absPath: string): string {
  const rel = relative(process.cwd(), absPath);
  return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : absPath;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function assignAgentNames(agents: Array<Partial<AgentConfig>>): AgentConfig[] {
  const roleCounts = new Map<string, number>();
  for (const agent of agents) {
    if (agent.role) roleCounts.set(agent.role, (roleCounts.get(agent.role) ?? 0) + 1);
  }

  const roleIndexes = new Map<string, number>();
  return agents.map((agent) => {
    if (!agent.role) fail("task.yml: every agent must define 'role'");
    const count = roleCounts.get(agent.role) ?? 0;
    const next = (roleIndexes.get(agent.role) ?? 0) + 1;
    roleIndexes.set(agent.role, next);
    return {
      ...agent,
      name: agent.name ?? (count > 1 ? `${agent.role}-${next}` : agent.role),
      role: agent.role,
    } as AgentConfig;
  });
}

function parseTaskYaml(text: string): TaskConfig {
  // Minimal YAML parser — only handles the task.yml shape in
  // docs/synapse-spec-task-manifest.md, plus optional per-agent `focus`
  // single-line or `|` block scalar.
  // Format:
  //   synapse_version: 0.1.0
  //   workflow: hub-and-spoke
  //   goal: "Implement X"
  //   agents:
  //     - role: manager
  //     - role: coder
  //       focus: <single line>        # or:
  //       focus: |
  //         multi
  //         line
  const lines = text.split("\n");
  let synapseVersion = "";
  let workflow = "";
  let goal: string | null = null;
  const agents: Array<Partial<AgentConfig>> = [];
  let current: Partial<AgentConfig> | null = null;
  // While collecting a `focus: |` block scalar, lines indented further than
  // this column belong to it; the first such line establishes the column.
  let blockIndent: number | null = null;
  const blockLines: string[] = [];

  const flushBlock = () => {
    if (blockIndent !== null && current) {
      current.focus = blockLines.join("\n").replace(/\n+$/, "");
    }
    blockIndent = null;
    blockLines.length = 0;
  };
  const indentOf = (s: string) => s.length - s.replace(/^\s+/, "").length;

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (blockIndent !== null) {
      if (line.trim() === "") {
        blockLines.push("");
        continue;
      }
      if (indentOf(line) >= blockIndent) {
        blockLines.push(line.slice(blockIndent));
        continue;
      }
      flushBlock();
      // fall through — this line starts something new, handled below
    }

    if (/^synapse_version:\s/.test(line)) {
      synapseVersion = unquoteYamlScalar(line.replace(/^synapse_version:\s+/, ""));
      continue;
    }
    if (/^workflow:\s/.test(line)) {
      workflow = unquoteYamlScalar(line.replace(/^workflow:\s+/, ""));
      continue;
    }
    if (/^goal:\s/.test(line)) {
      const value = unquoteYamlScalar(line.replace(/^goal:\s+/, ""));
      goal = value.length > 0 ? value : null;
      continue;
    }
    if (/^\s+-\s+role:\s/.test(line)) {
      if (current) agents.push(current);
      current = { role: unquoteYamlScalar(line.replace(/^\s+-\s+role:\s+/, "")) };
      continue;
    }
    if (/^\s+-\s+name:\s/.test(line)) {
      if (current) agents.push(current);
      current = { name: unquoteYamlScalar(line.replace(/^\s+-\s+name:\s+/, "")) };
      continue;
    }
    if (current && /^\s+name:\s/.test(line)) {
      current.name = unquoteYamlScalar(line.replace(/^\s+name:\s+/, ""));
      continue;
    }
    if (current && /^\s+role:\s/.test(line)) {
      current.role = unquoteYamlScalar(line.replace(/^\s+role:\s+/, ""));
      continue;
    }
    if (current && /^\s+focus:\s*\|\s*$/.test(line)) {
      blockIndent = indentOf(line) + 2; // YAML block scalars are conventionally +2
      blockLines.length = 0;
      continue;
    }
    if (current && /^\s+focus:\s/.test(line)) {
      current.focus = unquoteYamlScalar(line.replace(/^\s+focus:\s+/, ""));
      continue;
    }
  }
  flushBlock();
  if (current) agents.push(current);

  if (!synapseVersion) fail("task.yml: missing 'synapse_version' field");
  if (!workflow) fail("task.yml: missing 'workflow' field");
  if (workflow !== "hub-and-spoke") {
    fail(`task.yml: unsupported workflow '${workflow}'`);
  }
  if (agents.length === 0) fail("task.yml: no agents defined");
  const namedAgents = assignAgentNames(agents);
  const managers = namedAgents.filter((a) => a.role === "manager");
  if (managers.length !== 1) {
    fail("task.yml: hub-and-spoke workflow requires exactly one manager");
  }
  return { synapseVersion, workflow, goal, agents: namedAgents };
}

// ---------- CLAUDE.md assembly (bootstrap-spec.md dimension A + #5) ----------

// Three-segment assembly: shared block (all agents) + role block (per role,
// reused across instances of that role) + instance block (per agent, from
// task.yml's `focus` field). Written once into the synapse-managed scratch
// tree for a fresh task; task names are unique, so existing scratch is never
// overwritten.
function assembleClaudeMd(agent: AgentConfig): string {
  const sections: string[] = [SHARED_MD.trimEnd()];

  const roleBlock = ROLE_TEMPLATES[agent.role];
  if (roleBlock) {
    sections.push(roleBlock.trimEnd());
  } else {
    console.error(
      `synapse: warning — no role template for role '${agent.role}' (agent '${agent.name}'); CLAUDE.md will have the shared block only`,
    );
  }

  if (agent.focus && agent.focus.trim()) {
    sections.push(
      `## Your focus (${agent.name})\n\n${agent.focus.trim()}`,
    );
  }

  sections.push(
    `---\n\n_Generated by \`synapse start\` for agent \`${agent.name}\` (role: ${agent.role}). ` +
      `Regenerated and overwritten on every \`synapse start\` — edits made directly to this file do not persist._`,
  );

  return sections.join("\n\n") + "\n";
}

// Writes (overwrites) <absCwd>/CLAUDE.md, creating the directory if needed.
function writeAgentClaudeMd(absCwd: string, agent: AgentConfig): void {
  mkdirSync(absCwd, { recursive: true });
  writeFileSync(join(absCwd, "CLAUDE.md"), assembleClaudeMd(agent));
}

// ---------- unattended preflight (bootstrap-spec.md #7) ----------

// Workspace trust ("trust this folder") blocks unattended launch and isn't
// cleared by --dangerously-skip-permissions or git init. Claude Code records
// acceptance in ~/.claude.json under .projects[<canonical abs cwd>], keyed by
// the *symlink-resolved* path (macOS /var -> /private/var) — using
// path.resolve() instead of realpathSync here would silently fail to match.
function presetClaudeTrust(absCwd: string): void {
  const canonicalCwd = realpathSync(absCwd);
  const configPath = join(homedir(), ".claude.json");

  let config: any = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      console.error(
        `synapse: warning — ${configPath} is not valid JSON; leaving it untouched and skipping trust preseed`,
      );
      return;
    }
  }

  config.hasCompletedOnboarding = true;
  config.projects ??= {};
  config.projects[canonicalCwd] ??= {};
  config.projects[canonicalCwd].hasTrustDialogAccepted = true;

  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (err: any) {
    console.error(
      `synapse: warning — could not write ${configPath}; skipping trust preseed (${err?.message ?? err})`,
    );
  }
}

// Launches one agent window in the tmux session.
//
// claude requires a real TTY, so script(1) provides the pty. We pass
// --session-id explicitly so we know the session ID before launch — no need
// to poll ~/.claude/projects/ for a new transcript file (that approach, plus
// the "hi" nudge to coax a first jsonl write, has been removed: it was the
// fragile timing hack bootstrap-spec.md problem 2 set out to replace).
//
// The first-kick (bootstrap-spec.md #6/#7) is the bare minimum: `synapse
// pending <name>`, passed as claude's initial prompt so it runs the instant
// the session loads — no external actor has to guess when claude is ready.
// `--dangerously-skip-permissions` clears the per-tool-call approval prompt
// (the other unattended-launch gate, bootstrap-spec.md #7); presetClaudeTrust
// clears the one-time workspace-trust dialog before that.
function launchAgentWindow(
  tmuxSession: string,
  taskName: string,
  agent: AgentConfig,
  synapseDb: string,
  claudePath: string,
  sessionId: string,
  runId: number,
): void {
  const absCwd = resolve(defaultAgentDir(taskName, agent.name));
  presetClaudeTrust(absCwd);

  const initialPrompt = `synapse pending ${agent.name}`;
  const shellCmd = `
    cd '${absCwd}' || exit 1
    SYNAPSE_DB='${synapseDb}' SYNAPSE_AGENT='${agent.name}' SYNAPSE_RUN_ID='${runId}' script -q /dev/null '${claudePath}' --session-id '${sessionId}' --dangerously-skip-permissions '${initialPrompt}'
  `;

  if (process.env.SYNAPSE_DEBUG) {
    console.error(`[debug] window '${agent.name}' shellCmd:\n${shellCmd}`);
  }
  const result = Bun.spawnSync([
    "tmux",
    "new-window",
    "-t",
    tmuxSession,
    "-n",
    agent.name,
    "/bin/bash",
    "-c",
    shellCmd,
  ]);
  if (result.exitCode !== 0) {
    fail(
      `failed to create tmux window '${agent.name}': ${result.stderr.toString().trim()}`,
    );
  }
}

export function cmdStart(configPath: string, flags: Record<string, string>) {
  if (!existsSync(configPath)) fail(`task config not found: ${configPath}`);
  const absConfigPath = resolve(configPath);
  const config = parseTaskYaml(readFileSync(absConfigPath, "utf8"));
  const goal = flags["goal"] ?? config.goal;
  const noMonitor = flags["no-monitor"] === "true";

  const dbFile = dbPath();
  const dataDir = dirname(dbFile);
  mkdirSync(dataDir, { recursive: true });

  // Init DB now so we can get a run id for the task folder name.
  cmdInit();
  const db = connect();

  const runResult = db.run(
    `INSERT INTO runs (session, goal, status) VALUES ('', ?, 'running')`,
    [goal ?? ""],
  );
  const runId = Number(runResult.lastInsertRowid);
  const taskName = `run-${runId}`;

  // Create the durable run folder and copy task.yml into it with generated
  // links back to this run's scratch tree.
  const taskFolder = join(dataDir, "runs", taskName);
  const agentsDir = join(dataDir, "agents", taskName);
  mkdirSync(taskFolder, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  const taskText = readFileSync(absConfigPath, "utf8");
  writeFileSync(
    join(taskFolder, "task.yml"),
    appendGeneratedTaskFields(taskText, runId, workspaceRelativePath(agentsDir)),
  );
  console.log(`synapse: created run folder ${taskFolder}`);

  // Register operator pseudo-agent (run_id=0 = cross-run sentinel)
  db.run(
    `INSERT INTO agents (window_name, run_id, role, session_id, status, last_seen_at)
     VALUES ('operator', 0, 'operator', NULL, 'idle', ?)
     ON CONFLICT(window_name, run_id) DO UPDATE SET status='idle', last_seen_at=excluded.last_seen_at`,
    [nowIso()],
  );

  const tmuxSession = taskName;
  db.run(`UPDATE runs SET session=? WHERE id=?`, [tmuxSession, runId]);

  const sessionExists = Bun.spawnSync(["tmux", "has-session", "-t", tmuxSession]);
  if (sessionExists.exitCode === 0) {
    fail(
      `tmux session '${tmuxSession}' already exists for a fresh run id — this shouldn't happen; check for a stuck session (tmux kill-session -t ${tmuxSession}) and retry`,
    );
  }
  const newSession = Bun.spawnSync(["tmux", "new-session", "-d", "-s", tmuxSession]);
  if (newSession.exitCode !== 0) {
    fail(
      `failed to create tmux session '${tmuxSession}': ${newSession.stderr.toString().trim()}`,
    );
  }
  // Rename the default window created with the session (base-index agnostic)
  Bun.spawnSync(["tmux", "rename-window", "-t", tmuxSession, "monitor"]);

  const synapseCliPath = resolve(
    process.execPath === process.argv[0]
      ? process.argv[1] // running via bun src/synapse.ts
      : process.execPath, // compiled binary
  );

  // Resolve claude binary path at start time so tmux windows inherit it
  // even if their shell doesn't have the same PATH.
  const claudeWhich = Bun.spawnSync(["which", "claude"]);
  const claudePath =
    claudeWhich.exitCode === 0
      ? claudeWhich.stdout.toString().trim()
      : "claude";

  for (const agent of config.agents) {
    // Generate a UUID to pass as --session-id so we know it before launch.
    const sessionId = crypto.randomUUID();
    const absCwd = resolve(defaultAgentDir(taskName, agent.name));
    // Three-segment CLAUDE.md: generated in synapse-managed scratch from
    // templates plus this agent's task.yml `focus`.
    writeAgentClaudeMd(absCwd, agent);
    console.log(
      `synapse: launching window '${agent.name}' (${agent.role}) in ${absCwd}`,
    );
    launchAgentWindow(tmuxSession, taskName, agent, dbFile, claudePath, sessionId, runId);
    cmdRegister(agent.name, agent.role, sessionId, runId);
  }

  // Start monitor in the 'monitor' tmux window
  if (!noMonitor) {
    const monitorCmd = `SYNAPSE_DB='${dbFile}' ${synapseCliPath} monitor --session ${tmuxSession} --run-id ${runId} 2>&1 | tee '${dbFile.replace(/synapse\.db$/, "monitor.log")}'`;
    const r = Bun.spawnSync([
      "tmux",
      "send-keys",
      "-t",
      `${tmuxSession}:monitor`,
      monitorCmd,
      "Enter",
    ]);
    if (r.exitCode !== 0) {
      console.error(
        `synapse: warning — failed to start monitor: ${r.stderr.toString().trim()}`,
      );
    } else {
      console.log(`synapse: monitor started in window '${tmuxSession}:monitor'`);
    }
  }

  // Send initial goal as TASK from operator to the manager agent, if provided.
  if (goal) {
    const manager = config.agents.find((a) => a.role === "manager")!;
    cmdSend(manager.name, "TASK", goal, "operator", null, runId);
    console.log(`synapse: initial goal queued as TASK to '${manager.name}'`);
  }

  console.log(
    `synapse: team '${tmuxSession}' (run #${runId}) started with ${config.agents.length} agent(s)`,
  );
  console.log(`  Attach: tmux attach -t ${tmuxSession}`);
  console.log(`  Status: synapse status`);
  console.log(
    `  Finish: SYNAPSE_RUN_ID=${runId} synapse done --status done "<summary>"  (manager calls this, not the operator)`,
  );
}


// The hub agent's signal that the root task has reached a terminal outcome
// (bootstrap-spec.md #8/#13). Writes the run's terminal state and sends the
// final STATUS back to operator. The monitor stays alive after terminal state
// and keeps dispatching operator follow-ups until UI/operator ACK tears down
// the team.
export function cmdDone(
  status: string,
  summary: string,
  from: string | null,
  refIdFlag: number | null,
  runIdFlag: number | null,
) {
  const agent = resolveFrom(from);
  const dbStatus = status === "failed" ? "failed" : "completed";

  const db = connect();
  const runId = runIdFlag ?? (process.env.SYNAPSE_RUN_ID ? parseInt(process.env.SYNAPSE_RUN_ID, 10) : null);
  if (runId === null || Number.isNaN(runId)) {
    console.error(
      "synapse: warning — no run id (SYNAPSE_RUN_ID not set and --run-id not passed); runs table not updated",
    );
  } else {
    const result = db.run(
      "UPDATE runs SET status=?, ended_at=? WHERE id=? AND status='running'",
      [dbStatus, nowIso(), runId],
    );
    if (result.changes === 0) {
      console.error(
        `synapse: warning — run ${runId} not found or already finished`,
      );
    }
  }

  // Default ref_id to the root TASK addressed to this agent, if not given —
  // that's the message this STATUS is closing out.
  let refId = refIdFlag;
  if (refId === null) {
    const root = runId !== null
      ? db
          .query(
            `SELECT id FROM messages WHERE to_agent=? AND type='TASK' AND ref_id IS NULL AND run_id=? ORDER BY id DESC LIMIT 1`,
          )
          .get(agent, runId) as any
      : db
          .query(
            `SELECT id FROM messages WHERE to_agent=? AND type='TASK' AND ref_id IS NULL ORDER BY id DESC LIMIT 1`,
          )
          .get(agent) as any;
    refId = root?.id ?? null;
  }

  cmdSend("operator", "STATUS", summary, agent, refId, runId);
  console.log(
    `synapse: done — run ${runId ?? "?"} marked '${dbStatus}', final STATUS sent to operator`,
  );
}

export function cmdStop(name: string, tmuxSession: string, runId?: number) {
  const db = connect();
  const resolvedRunId = runId ?? (process.env.SYNAPSE_RUN_ID ? parseInt(process.env.SYNAPSE_RUN_ID, 10) : null);
  const agent = resolvedRunId !== null
    ? db.query("SELECT * FROM agents WHERE window_name=? AND run_id=?").get(name, resolvedRunId) as any
    : db.query("SELECT * FROM agents WHERE window_name=?").get(name) as any;
  if (!agent) fail(`no registered agent named '${name}'${resolvedRunId !== null ? ` in run ${resolvedRunId}` : ""}`);

  db.run(
    "UPDATE agents SET status='stopped', last_seen_at=? WHERE window_name=? AND run_id=?",
    [nowIso(), name, agent.run_id],
  );

  const killResult = Bun.spawnSync([
    "tmux",
    "kill-window",
    "-t",
    `${tmuxSession}:${name}`,
  ]);
  if (killResult.exitCode !== 0) {
    const stderr = killResult.stderr.toString().trim();
    console.error(`synapse: warning — tmux kill-window failed: ${stderr}`);
  }
  console.log(`synapse: agent '${name}' stopped`);
}

export function cmdAttach(name: string, tmuxSession: string) {
  const result = Bun.spawnSync(
    ["tmux", "attach-session", "-t", `${tmuxSession}:${name}`],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  if (result.exitCode !== 0) {
    fail(`tmux attach failed: ${result.stderr?.toString().trim()}`);
  }
}
