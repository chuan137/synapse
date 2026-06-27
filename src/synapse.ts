#!/usr/bin/env bun
/**
 * synapse — CLI for the Claude Team Synapse message bus.
 *
 * Commands:
 *   synapse init
 *   synapse register <name> <role> [session_id]
 *   synapse send <to> <type> <body> [--from NAME] [--ref-id N]
 *   synapse log <agent> <type> <summary>
 *   synapse status
 *   synapse pending [agent]
 *   synapse deliver <id>
 *   synapse monitor [--session NAME] [--interval MS] [--debounce MS] [--once]
 *   synapse start <team.yaml> [--goal "text"] [--no-monitor]
 *   synapse stop <name> [--session SESSION]
 *   synapse attach <name> [--session SESSION]
 *   synapse ui [--port N]
 *
 * DB location: $SYNAPSE_DB, else ./.synapse/synapse.db
 * Transcript root: $CLAUDE_PROJECTS_DIR, else ~/.claude/projects
 *
 * Build: bun build src/synapse.ts --compile --outfile synapse
 */
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  watch as fsWatch,
} from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
// Bundled as text so it's available inside a --compile binary with no schema.sql beside it.
import SCHEMA_SQL from "./schema.sql" with { type: "text" };

const MESSAGE_TYPES = new Set(["TASK", "STATUS", "REVIEW", "ACK", "INFO"]);
const EVENT_TYPES = new Set(["task_start", "task_end", "decision"]);

const DEFAULT_TMUX_SESSION = "team";
// Cheap mailbox/roster sweep — idle detection is event-driven, not on this timer.
const DEFAULT_SWEEP_INTERVAL_MS = 1000;
const DEFAULT_DEBOUNCE_MS = 2000;

// Stored in PRAGMA user_version so detection works before any table exists.
const SCHEMA_VERSION = 1;

function dbPath(): string {
  return resolve(process.env.SYNAPSE_DB ?? "./.synapse/synapse.db");
}

function connect(createParent = false): Database {
  const path = dbPath();
  if (createParent) {
    mkdirSync(dirname(path), { recursive: true });
  } else if (!existsSync(path)) {
    console.error(
      `synapse: no DB at ${path} — run \`synapse init\` first (or set SYNAPSE_DB).`,
    );
    process.exit(1);
  }
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  return db;
}

function nowIso(): string {
  return new Date().toISOString().slice(0, 19);
}

function fail(msg: string): never {
  console.error(`synapse: ${msg}`);
  process.exit(1);
}

const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
};
function colorType(t: string): string {
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

// ---------- commands ----------

// Returns schema version (0 = never set) and whether tables exist.
function probeSchema(db: Database): { version: number; hasTables: boolean } {
  const version = (db.query("PRAGMA user_version").get() as any)
    .user_version as number;
  const hasTables = !!db
    .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents'")
    .get();
  return { version, hasTables };
}

function cmdInit() {
  const path = dbPath();
  const dataDir = dirname(path);

  if (existsSync(path)) {
    const probe = new Database(path);
    const { version, hasTables } = probeSchema(probe);
    probe.close();

    if (version > SCHEMA_VERSION) {
      fail(
        `DB at ${path} is schema v${version}, newer than this binary supports (v${SCHEMA_VERSION}). Upgrade synapse before running init.`,
      );
    }
    if (hasTables && version < SCHEMA_VERSION) {
      // Move the whole data directory aside — it may also hold audit logs that
      // belong with the old DB, not mixed into the fresh one.
      const backupDir = `${dataDir}.v${version}.bak-${Date.now()}`;
      renameSync(dataDir, backupDir);
      console.log(
        `synapse: found pre-v${SCHEMA_VERSION} data (schema v${version}) at ${dataDir} — moved entire folder to ${backupDir}`,
      );
    }
    // hasTables===false or already current version: fall through, schema creation is idempotent.
  }

  const db = connect(true);
  db.exec(SCHEMA_SQL);
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);
  console.log(`synapse: initialized ${path} (schema v${SCHEMA_VERSION})`);
}

function cmdRegister(name: string, role: string, sessionId: string | null) {
  const db = connect();
  db.run(
    `INSERT INTO agents (window_name, role, session_id, status, last_seen_at)
     VALUES (?, ?, ?, 'unknown', ?)
     ON CONFLICT(window_name) DO UPDATE SET
       role=excluded.role,
       session_id=excluded.session_id,
       last_seen_at=excluded.last_seen_at`,
    [name, role, sessionId, nowIso()],
  );
  console.log(
    `synapse: registered '${name}' (role=${role}, session_id=${sessionId ?? "-"})`,
  );
}

function resolveFrom(from: string | null): string {
  const frm = from ?? process.env.SYNAPSE_AGENT;
  if (!frm) fail("missing sender — pass --from NAME or set SYNAPSE_AGENT");
  return frm;
}

function cmdSend(
  to: string,
  type: string,
  body: string,
  from: string | null,
  refId: number | null,
) {
  if (!MESSAGE_TYPES.has(type)) {
    fail(`type must be one of ${[...MESSAGE_TYPES].sort()}, got '${type}'`);
  }
  const frm = resolveFrom(from);
  const db = connect();
  if (to !== "broadcast") {
    const known = db.query("SELECT 1 FROM agents WHERE window_name=?").get(to);
    if (!known) {
      console.error(
        `synapse: warning — '${to}' not in agents registry yet (sending anyway)`,
      );
    }
  }
  const result = db.run(
    `INSERT INTO messages (from_agent, to_agent, type, ref_id, body)
     VALUES (?, ?, ?, ?, ?)`,
    [frm, to, type, refId, body],
  );
  console.log(
    `synapse: message ${result.lastInsertRowid} queued (${frm} -> ${to}, ${type}${
      refId ? ", ref=" + refId : ""
    })`,
  );
}

function cmdLog(agent: string, type: string, summary: string) {
  if (!EVENT_TYPES.has(type)) {
    console.error(
      `synapse: warning — '${type}' is outside the suggested vocab ${[
        ...EVENT_TYPES,
      ].sort()} (logging anyway)`,
    );
  }
  const db = connect();
  const result = db.run(
    "INSERT INTO events (agent, type, summary) VALUES (?, ?, ?)",
    [agent, type, summary],
  );
  console.log(
    `synapse: event ${result.lastInsertRowid} logged (${agent}, ${type})`,
  );
}

function cmdStatus() {
  const db = connect();
  const agents = db
    .query("SELECT * FROM agents ORDER BY role, window_name")
    .all() as any[];
  if (agents.length === 0) {
    console.log("synapse: no agents registered");
    return;
  }
  const pendingStmt = db.query(
    `SELECT COUNT(*) AS n FROM messages WHERE status='pending'
     AND (to_agent=? OR to_agent='broadcast')`,
  );
  const headers = [
    "WINDOW",
    "ROLE",
    "STATUS",
    "SESSION_ID",
    "LAST_SEEN",
    "PENDING",
  ];
  const rows = agents.map((a) => {
    const pending = (pendingStmt.get(a.window_name) as any).n;
    return [
      a.window_name,
      a.role,
      a.status,
      a.session_id ?? "-",
      a.last_seen_at ?? "-",
      String(pending),
    ];
  });
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmt = (cols: string[]) =>
    cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(fmt(headers));
  for (const r of rows) console.log(fmt(r));
}

function cmdPending(agent: string | null) {
  const db = connect();
  const rows = agent
    ? (db
        .query(
          `SELECT * FROM messages WHERE status='pending'
           AND (to_agent=? OR to_agent='broadcast') ORDER BY created_at`,
        )
        .all(agent) as any[])
    : (db
        .query(
          "SELECT * FROM messages WHERE status='pending' ORDER BY created_at",
        )
        .all() as any[]);
  if (rows.length === 0) {
    console.log("synapse: no pending messages");
    return;
  }
  const agentW = Math.max(
    ...rows.flatMap((r) => [r.from_agent.length, r.to_agent.length]),
  );
  const typeW = Math.max(...rows.map((r) => r.type.length));
  const refW = Math.max(
    ...rows.map((r) => (r.ref_id ? `ref:#${r.ref_id}`.length : 0)),
  );
  for (const r of rows) {
    const route = `${r.from_agent.padEnd(agentW)} → ${r.to_agent.padEnd(agentW)}`;
    const type = colorType(r.type) + " ".repeat(typeW - r.type.length);
    const refRaw = r.ref_id ? `ref:#${r.ref_id}` : "";
    const ref = refRaw
      ? `${c.dim}${refRaw}${c.reset}` + " ".repeat(refW - refRaw.length)
      : " ".repeat(refW);
    const ts = `${c.dim}${r.created_at.slice(0, 16)}${c.reset}`;
    const id = `${c.dim}#${String(r.id).padStart(2)}${c.reset}`;
    console.log(`${id}  ${route}  ${type}  ${ref}  ${ts}`);
    console.log(`      ${r.body}`);
    console.log();
  }
}

function cmdDeliver(id: number) {
  const db = connect();
  const result = db.run(
    "UPDATE messages SET status='delivered', delivered_at=? WHERE id=? AND status='pending'",
    [nowIso(), id],
  );
  if (result.changes === 0) fail(`no pending message with id=${id}`);
  console.log(`synapse: message ${id} marked delivered`);
}

// ---------- monitor ----------

type IdleState = "idle" | "busy" | "unknown";
type IdleStateResult = {
  state: IdleState;
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
): IdleStateResult {
  const path = findTranscriptPath(sessionId);
  if (!path) return { state: "unknown", detail: "no transcript found yet" };

  const stopReason = lastAssistantStopReason(path);
  if (!stopReason) return { state: "unknown", detail: "no assistant turn yet" };

  if (stopReason !== "end_turn") {
    return { state: "busy", detail: `stop_reason=${stopReason}` };
  }

  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(path).mtimeMs;
  } catch {
    return { state: "unknown", detail: "transcript unreadable" };
  }
  if (ageMs < debounceMs) {
    return {
      state: "busy",
      detail: `end_turn, debouncing (${Math.round(ageMs)}ms)`,
      remainingDebounceMs: debounceMs - ageMs,
    };
  }
  return {
    state: "idle",
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
    // Delivery failures are terminal in v1. Operators can inspect failed rows;
    // automatic retry would need retry_count/next_retry_at plus a redelivery path.
    db.run("UPDATE messages SET status='failed' WHERE id=?", [msg.id]);
    log(
      `  [${msg.id}] ${msg.from_agent} -> ${windowName} (${msg.type}) FAILED: ${res.error}`,
    );
  }
}

// Dispatches the oldest pending direct message for windowName, if any.
function dispatchNextDirectMessage(
  db: Database,
  tmuxSession: string,
  windowName: string,
  log: (s: string) => void,
) {
  const msg = db
    .query(
      `SELECT * FROM messages WHERE status='pending' AND to_agent=?
       ORDER BY created_at LIMIT 1`,
    )
    .get(windowName) as any;
  if (msg) dispatchDirectMessage(db, tmuxSession, windowName, msg, log);
}

function hasPendingDirectMessageForWindow(
  db: Database,
  windowName: string,
): boolean {
  const row = db
    .query(
      `SELECT 1 FROM messages WHERE status='pending' AND to_agent=? LIMIT 1`,
    )
    .get(windowName);
  return !!row;
}

// Broadcasts fire only when every non-sender agent is idle simultaneously —
// a single row can't track partial delivery, so it's all-or-nothing.
function broadcastReadyMessages(
  db: Database,
  tmuxSession: string,
  agents: any[],
  idleStates: Map<string, IdleState>,
  log: (s: string) => void,
) {
  const broadcasts = db
    .query(
      `SELECT * FROM messages WHERE status='pending' AND to_agent='broadcast' ORDER BY created_at`,
    )
    .all() as any[];
  for (const msg of broadcasts) {
    const recipients = agents.filter((a) => a.window_name !== msg.from_agent);
    if (recipients.length === 0) continue;
    const allIdle = recipients.every(
      (a) => idleStates.get(a.window_name) === "idle",
    );
    if (!allIdle) continue;
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

function readTmuxPaneState(tmuxSession: string, windowName: string): IdleStateResult {
  const pane = Bun.spawnSync([
    "tmux", "capture-pane", "-t", `${tmuxSession}:${windowName}`, "-p",
  ]);
  const paneText = pane.stdout.toString();
  const isIdle = /[❯$#]\s*$/.test(paneText.trimEnd());
  return { state: isIdle ? "idle" : "busy", detail: "tmux-pane-fallback" };
}

// Reads agent state from transcript (or tmux pane fallback) and persists any transition.
// idleStates acts as both prev-state tracker and the snapshot broadcastReadyMessages reads.
function updateAgentState(
  db: Database,
  debounceMs: number,
  agent: any,
  idleStates: Map<string, IdleState>,
  log: (s: string) => void,
  tmuxSession?: string,
): IdleStateResult | null {
  let result: IdleStateResult;
  if (agent.session_id && agent.session_id !== "-") {
    result = readTranscriptState(agent.session_id, debounceMs);
  } else if (tmuxSession) {
    result = readTmuxPaneState(tmuxSession, agent.window_name);
  } else {
    return null;
  }

  const { state, detail } = result;
  const prev = idleStates.get(agent.window_name) ?? agent.status;
  idleStates.set(agent.window_name, state);
  if (state === "unknown") {
    log(`  ${agent.window_name}: unknown (${detail})`);
    return result;
  }
  if (state !== prev) {
    log(`  ${agent.window_name}: ${prev} -> ${state} (${detail})`);
    // Guarded so a concurrent deregister wins — don't resurrect a stopped row.
    const update = db.run(
      "UPDATE agents SET status=?, last_seen_at=? WHERE window_name=? AND status != 'stopped'",
      [state, nowIso(), agent.window_name],
    );
    if (update.changes === 0) {
      idleStates.delete(agent.window_name);
      log(`  ${agent.window_name}: stopped before readiness update`);
      return null;
    }
  }

  return result;
}

// Single synchronous snapshot — evaluate every live agent, then broadcast if ready.
function pollOnce(
  db: Database,
  tmuxSession: string,
  debounceMs: number,
  log: (s: string) => void,
) {
  const agents = db
    .query("SELECT * FROM agents WHERE status != 'stopped'")
    .all() as any[];
  const idleStates = new Map<string, IdleState>();
  for (const agent of agents) {
    if (agent.window_name === "operator") continue;
    const result = updateAgentState(db, debounceMs, agent, idleStates, log, tmuxSession);
    if (result?.state === "idle") {
      dispatchNextDirectMessage(db, tmuxSession, agent.window_name, log);
    }
  }
  broadcastReadyMessages(db, tmuxSession, agents, idleStates, log);
}

// Callers get a single onChange(key, path) callback for each fs.watch event,
// initial watch registration, and mtime-based recheck.
class FileWatchPool {
  private watchers = new Map<string, ReturnType<typeof fsWatch>>();
  private paths = new Map<string, string>();
  private mtimes = new Map<string, number>();

  constructor(private onChange: (key: string, path: string) => void) {}

  // Idempotent. Fires onChange immediately so callers don't need a separate
  // initial-evaluation step.
  watch(key: string, path: string): void {
    if (this.watchers.has(key)) return;
    this.paths.set(key, path);
    this.recordMtime(key, path);
    this.watchers.set(
      key,
      fsWatch(path, () => this.emitChange(key)),
    );
    this.onChange(key, path);
  }

  unwatch(key: string): void {
    this.watchers.get(key)?.close();
    this.watchers.delete(key);
    this.paths.delete(key);
    this.mtimes.delete(key);
  }

  isWatching(key: string): boolean {
    return this.watchers.has(key);
  }

  watchedKeys(): IterableIterator<string> {
    return this.watchers.keys();
  }

  emitOnTranscriptChange(key: string): void {
    const path = this.paths.get(key);
    if (!path) return;
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      return;
    }
    if (mtime !== this.mtimes.get(key)) this.emitChange(key);
  }

  closeAll(): void {
    for (const key of [...this.watchers.keys()]) this.unwatch(key);
  }

  private emitChange(key: string): void {
    const path = this.paths.get(key);
    if (!path) return;
    this.recordMtime(key, path);
    this.onChange(key, path);
  }

  private recordMtime(key: string, path: string): void {
    try {
      this.mtimes.set(key, statSync(path).mtimeMs);
    } catch {
      // Mid-write/rotate — next fs.watch event or sweep mtime check will retry.
    }
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
) {
  const idleStates = new Map<string, IdleState>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let agents: any[] = [];
  let agentsByWindow = new Map<string, any>();

  const refreshAgents = () => {
    agents = db
      .query(
        "SELECT * FROM agents WHERE status != 'stopped' AND session_id IS NOT NULL",
      )
      .all() as any[];
    agentsByWindow = new Map(agents.map((a) => [a.window_name, a]));
  };

  const evaluateWindowReadiness = (windowName: string) => {
    const agent = agentsByWindow.get(windowName);
    if (!agent) return null; // deregistered/stopped between event and update
    return updateAgentState(db, debounceMs, agent, idleStates, log);
  };

  const deliverIfIdle = (windowName: string) => {
    const result = evaluateWindowReadiness(windowName);
    if (result?.state === "idle") {
      cancelScheduledDelivery(windowName);
      dispatchNextDirectMessage(db, tmuxSession, windowName, log);
      broadcastReadyMessages(db, tmuxSession, agents, idleStates, log);
    } else if (result?.remainingDebounceMs !== undefined) {
      scheduleDelivery(windowName, result.remainingDebounceMs);
    }
  };

  const cancelScheduledDelivery = (windowName: string) => {
    const existing = debounceTimers.get(windowName);
    if (existing) clearTimeout(existing);
    debounceTimers.delete(windowName);
  };

  const scheduleDelivery = (windowName: string, delayMs: number) => {
    cancelScheduledDelivery(windowName);
    debounceTimers.set(
      windowName,
      setTimeout(
        () => {
          debounceTimers.delete(windowName);
          deliverIfIdle(windowName);
        },
        Math.max(0, delayMs),
      ),
    );
  };

  const onTranscriptActivity = (windowName: string) => {
    cancelScheduledDelivery(windowName);
    deliverIfIdle(windowName);
  };

  const pool = new FileWatchPool((windowName) =>
    onTranscriptActivity(windowName),
  );

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

  // Sweep syncs watcher/timer state with the live roster, cleans up stopped
  // agents, retries pending delivery for agents already idle, and broadcasts
  // ready messages.
  const sweep = () => {
    refreshAgents();
    const liveNames = new Set(agents.map((a) => a.window_name));
    const trackedNames = new Set([
      ...idleStates.keys(),
      ...pool.watchedKeys(),
      ...debounceTimers.keys(),
    ]);
    // Clean up stopped agents
    for (const name of trackedNames) {
      if (liveNames.has(name)) continue;
      pool.unwatch(name);
      idleStates.delete(name);
      cancelScheduledDelivery(name);
      log(`  ${name}: stopped, cleanup`);
    }
    for (const agent of agents) {
      const result = evaluateWindowReadiness(agent.window_name);

      // Mail can arrive without transcript activity.
      if (result?.state === "idle") {
        dispatchNextDirectMessage(db, tmuxSession, agent.window_name, log);
      }
      if (pool.isWatching(agent.window_name)) {
        pool.emitOnTranscriptChange(agent.window_name);
      } else {
        // fs.watch needs an existing path — poll until the transcript appears.
        const path = findTranscriptPath(agent.session_id);
        if (path) {
          pool.watch(agent.window_name, path);
          log(`  ${agent.window_name}: watching ${path}`);
        }
      }
    }
    broadcastReadyMessages(db, tmuxSession, agents, idleStates, log);
  };

  sweep();
  sweepTimer = setInterval(sweep, sweepMs);
}

// ---------- team.yaml / bootstrap ----------

interface AgentConfig {
  name: string;
  role: string;
  cwd: string;
}

interface TeamConfig {
  session: string;
  agents: AgentConfig[];
}

function parseTeamYaml(text: string): TeamConfig {
  // Minimal YAML parser — only handles the flat list shape used in synapse-spec.md.
  // Format:
  //   session: <name>
  //   agents:
  //     - name: <n>
  //       role: <r>
  //       cwd: <path>
  const lines = text.split("\n");
  let session = "";
  const agents: AgentConfig[] = [];
  let current: Partial<AgentConfig> | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^session:\s/.test(line)) {
      session = line.replace(/^session:\s+/, "").trim();
      continue;
    }
    if (/^\s+-\s+name:\s/.test(line)) {
      if (current && current.name && current.role && current.cwd)
        agents.push(current as AgentConfig);
      current = { name: line.replace(/^\s+-\s+name:\s+/, "").trim() };
      continue;
    }
    if (current && /^\s+role:\s/.test(line)) {
      current.role = line.replace(/^\s+role:\s+/, "").trim();
      continue;
    }
    if (current && /^\s+cwd:\s/.test(line)) {
      current.cwd = line.replace(/^\s+cwd:\s+/, "").trim();
      continue;
    }
  }
  if (current && current.name && current.role && current.cwd)
    agents.push(current as AgentConfig);

  if (!session) fail("team.yaml: missing 'session' field");
  if (agents.length === 0) fail("team.yaml: no agents defined");
  return { session, agents };
}

function claudeProjectsRoot(): string {
  return (
    process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects")
  );
}

function listClaudeSessionIdsForCwd(absCwd: string): Set<string> {
  const slug = cwdToProjectSlug(absCwd);
  const dir = join(claudeProjectsRoot(), slug);
  const ids = new Set<string>();
  if (!existsSync(dir)) return ids;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return ids;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    ids.add(entry.slice(0, -".jsonl".length));
  }
  return ids;
}

function findNewClaudeSessionIdForCwd(
  absCwd: string,
  before: Set<string>,
  launchTime: number,
): string | null {
  const slug = cwdToProjectSlug(absCwd);
  const dir = join(claudeProjectsRoot(), slug);
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const id = entry.slice(0, -".jsonl".length);
    // New session: file didn't exist before launch
    if (!before.has(id)) return id;
    // Resumed session: file existed but was written to after launch
    try {
      const mtime = statSync(join(dir, entry)).mtimeMs;
      if (mtime > launchTime) return id;
    } catch {}
  }
  return null;
}

// Polls Claude's project transcript directory for the new session .jsonl file.
// The .jsonl filename is the Claude session id.
function waitForSessionId(
  agentCwd: string,
  transcriptIdsBeforeLaunch: Set<string>,
  launchTime: number,
  timeoutMs: number,
  tmuxSession: string,
  windowName: string,
  intervalMs = 500,
): string | null {
  const deadline = Date.now() + timeoutMs;
  const absCwd = resolve(agentCwd);
  if (process.env.SYNAPSE_DEBUG) {
    const slug = cwdToProjectSlug(absCwd);
    const dir = join(claudeProjectsRoot(), slug);
    console.error(
      `[debug] watching ${dir} for new .jsonl (before: ${[...transcriptIdsBeforeLaunch].join(",") || "(empty)"})`,
    );
  }
  let nudged = false;
  while (Date.now() < deadline) {
    const transcriptSessionId = findNewClaudeSessionIdForCwd(
      absCwd,
      transcriptIdsBeforeLaunch,
      launchTime,
    );
    if (transcriptSessionId) return transcriptSessionId;
    // After 3s, send a nudge message to trigger the first jsonl write
    if (!nudged && Date.now() > launchTime + 3000) {
      Bun.spawnSync([
        "tmux",
        "send-keys",
        "-t",
        `${tmuxSession}:${windowName}`,
        "hi",
        "Enter",
      ]);
      nudged = true;
      if (process.env.SYNAPSE_DEBUG)
        console.error(`[debug] nudged ${windowName} to trigger jsonl`);
    }
    Bun.sleepSync(intervalMs);
  }
  return null;
}

// Derive the Claude projects slug from a directory path.
// Claude uses the absolute path with '/' replaced by '-' (leading '-' included).
function cwdToProjectSlug(absCwd: string): string {
  // Claude replaces every non-alphanumeric character (including '.' and '/') with '-'.
  return absCwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// Launches one agent window in the tmux session.
// claude requires a real TTY, so script(1) provides the pty.
// We pass --session-id explicitly so we know the session ID before launch.
function launchAgentWindow(
  tmuxSession: string,
  agent: AgentConfig,
  synapseDb: string,
  claudePath: string,
  sessionId: string,
): void {
  const absCwd = resolve(agent.cwd);
  const shellCmd = `
    cd '${absCwd}' || exit 1
    SYNAPSE_DB='${synapseDb}' SYNAPSE_AGENT='${agent.name}' script -q /dev/null '${claudePath}' --session-id '${sessionId}'
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

function cmdStart(configPath: string, flags: Record<string, string>) {
  if (!existsSync(configPath)) fail(`team config not found: ${configPath}`);
  const config = parseTeamYaml(readFileSync(configPath, "utf8"));
  const goal = flags["goal"] ?? null;
  const noMonitor = flags["no-monitor"] === "true";

  const dbFile = dbPath();
  const dataDir = dirname(dbFile);
  mkdirSync(dataDir, { recursive: true });

  // Init DB (idempotent)
  cmdInit();

  const db = connect();

  // Register operator pseudo-agent
  db.run(
    `INSERT INTO agents (window_name, role, session_id, status, last_seen_at)
     VALUES ('operator', 'operator', NULL, 'idle', ?)
     ON CONFLICT(window_name) DO UPDATE SET status='idle', last_seen_at=excluded.last_seen_at`,
    [nowIso()],
  );

  // Create tmux session (fail gracefully if it exists)
  const sessionExists = Bun.spawnSync([
    "tmux",
    "has-session",
    "-t",
    config.session,
  ]);
  if (sessionExists.exitCode !== 0) {
    const newSession = Bun.spawnSync([
      "tmux",
      "new-session",
      "-d",
      "-s",
      config.session,
    ]);
    if (newSession.exitCode !== 0) {
      fail(
        `failed to create tmux session '${config.session}': ${newSession.stderr.toString().trim()}`,
      );
    }
    // Rename the default window created with the session (base-index agnostic)
    Bun.spawnSync([
      "tmux",
      "rename-window",
      "-t",
      `${config.session}`,
      "monitor",
    ]);
  } else {
    console.log(
      `synapse: tmux session '${config.session}' already exists — reusing`,
    );
  }

  // Check if agents are already registered (idempotent re-start)
  const agentNames = config.agents.map((a) => a.name);
  const placeholders = agentNames.map(() => "?").join(",");
  const existing = (
    db
      .query(
        `SELECT window_name FROM agents WHERE window_name IN (${placeholders}) AND status != 'stopped'`,
      )
      .all(...agentNames) as any[]
  ).map((r) => r.window_name);

  if (existing.length === agentNames.length) {
    console.log(
      `synapse: team '${config.session}' already running — reusing existing agents`,
    );
    console.log(`  Attach: tmux attach -t ${config.session}`);
    console.log(`  Status: synapse status`);
    return;
  }

  // Launch each agent window and capture session ids
  const transcriptIdsBeforeLaunch: Map<string, Set<string>> = new Map();
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
    console.log(
      `synapse: launching window '${agent.name}' (${agent.role}) in ${agent.cwd}`,
    );
    launchAgentWindow(config.session, agent, dbFile, claudePath, sessionId);
    cmdRegister(agent.name, agent.role, sessionId);
  }

  // Start monitor in the 'monitor' tmux window
  if (!noMonitor) {
    const monitorCmd = `SYNAPSE_DB='${dbFile}' ${synapseCliPath} monitor --session ${config.session} 2>&1 | tee '${dbFile.replace(/synapse\.db$/, "monitor.log")}'`;
    const r = Bun.spawnSync([
      "tmux",
      "send-keys",
      "-t",
      `${config.session}:monitor`,
      monitorCmd,
      "Enter",
    ]);
    if (r.exitCode !== 0) {
      console.error(
        `synapse: warning — failed to start monitor: ${r.stderr.toString().trim()}`,
      );
    } else {
      console.log(
        `synapse: monitor started in window '${config.session}:monitor'`,
      );
    }
  }

  // Send initial goal as TASK from operator to first planner agent, if provided
  if (goal) {
    const planner = config.agents.find((a) => a.role === "planner");
    if (!planner) {
      console.error(
        "synapse: warning — no planner agent found; cannot send initial goal",
      );
    } else {
      cmdSend(planner.name, "TASK", goal, "operator", null);
      console.log(`synapse: initial goal queued as TASK to '${planner.name}'`);
    }
  }

  console.log(
    `synapse: team '${config.session}' started with ${config.agents.length} agent(s)`,
  );
  console.log(`  Attach: tmux attach -t ${config.session}`);
  console.log(`  Status: synapse status`);
}

function cmdStop(name: string, tmuxSession: string) {
  const db = connect();
  const agent = db
    .query("SELECT * FROM agents WHERE window_name=?")
    .get(name) as any;
  if (!agent) fail(`no registered agent named '${name}'`);

  db.run(
    "UPDATE agents SET status='stopped', last_seen_at=? WHERE window_name=?",
    [nowIso(), name],
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

function cmdAttach(name: string, tmuxSession: string) {
  const result = Bun.spawnSync(
    ["tmux", "attach-session", "-t", `${tmuxSession}:${name}`],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  if (result.exitCode !== 0) {
    fail(`tmux attach failed: ${result.stderr?.toString().trim()}`);
  }
}

function cmdMonitor(flags: Record<string, string>) {
  const tmuxSession = flags["session"] ?? DEFAULT_TMUX_SESSION;
  const sweepMs = flags["interval"]
    ? parseInt(flags["interval"], 10)
    : DEFAULT_SWEEP_INTERVAL_MS;
  const debounceMs = flags["debounce"]
    ? parseInt(flags["debounce"], 10)
    : DEFAULT_DEBOUNCE_MS;
  const once = flags["once"] === "true";

  const db = connect();
  const log = (s: string) => console.log(`[${nowIso()}] ${s}`);

  if (once) {
    pollOnce(db, tmuxSession, debounceMs, log);
    return;
  }

  runLiveMonitor(db, tmuxSession, debounceMs, sweepMs, log);
}

// ---------- ui ----------

const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synapse</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #1a1a1a; --bg2: #242424; --bg3: #2e2e2e; --border: #3a3a3a;
    --text: #e0e0e0; --text-muted: #888;
    --green: #4caf50; --yellow: #ffc107; --blue: #2196f3; --gray: #757575; --red: #f44336;
  }
  html, body { height: 100%; background: var(--bg); color: var(--text); font-family: monospace; font-size: 13px; }
  body { display: flex; flex-direction: column; }
  header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 16px; background: var(--bg2); border-bottom: 1px solid var(--border); flex-shrink: 0;
  }
  header .title { font-size: 15px; font-weight: bold; letter-spacing: 1px; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; background: var(--gray); }
  .status-dot.connected { background: var(--green); }
  .status-label { color: var(--text-muted); font-size: 12px; }
  .main { display: flex; flex: 1; min-height: 0; }
  .panel-agents { width: 220px; flex-shrink: 0; border-right: 1px solid var(--border); display: flex; flex-direction: column; }
  .panel-header { padding: 6px 10px; background: var(--bg3); border-bottom: 1px solid var(--border); font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; }
  .panel-header-row { display: flex; align-items: center; justify-content: space-between; }
  #agent-table { flex: 1; overflow-y: auto; }
  .agent-row { display: flex; align-items: center; gap: 6px; padding: 5px 10px; border-bottom: 1px solid var(--border); }
  .agent-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
  .agent-dot.idle { background: var(--green); }
  .agent-dot.busy { background: var(--yellow); }
  .agent-dot.stopped, .agent-dot.unknown { background: var(--gray); }
  .agent-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agent-role { color: var(--text-muted); font-size: 11px; }
  .agent-pending { background: var(--yellow); color: #000; font-size: 10px; padding: 0 4px; border-radius: 8px; line-height: 16px; flex-shrink: 0; }
  .panel-messages { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #msg-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; }
  .msg-row { padding: 5px 12px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; align-items: flex-start; line-height: 1.4; }
  .msg-meta { display: flex; gap: 6px; flex-shrink: 0; align-items: baseline; flex-wrap: wrap; }
  .msg-id { color: var(--text-muted); font-size: 11px; min-width: 30px; }
  .msg-route { color: var(--text-muted); font-size: 11px; white-space: nowrap; }
  .msg-type { font-size: 11px; font-weight: bold; padding: 0 5px; border-radius: 3px; line-height: 16px; flex-shrink: 0; }
  .msg-type.TASK   { background: #1a3a5c; color: #64b5f6; }
  .msg-type.STATUS { background: #1a3d1a; color: #81c784; }
  .msg-type.REVIEW { background: #3d2e00; color: #ffd54f; }
  .msg-type.ACK, .msg-type.INFO { background: #2e2e2e; color: #aaa; }
  .msg-status { font-size: 10px; color: var(--text-muted); flex-shrink: 0; }
  .msg-body { flex: 1; word-break: break-word; color: var(--text); white-space: pre-wrap; }
  .msg-time { font-size: 10px; color: var(--text-muted); flex-shrink: 0; white-space: nowrap; }
  .send-bar { flex-shrink: 0; border-top: 1px solid var(--border); background: var(--bg2); padding: 8px 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .send-bar label { color: var(--text-muted); font-size: 12px; }
  .send-bar select, .send-bar input[type=text] { background: var(--bg3); border: 1px solid var(--border); color: var(--text); font-family: monospace; font-size: 13px; padding: 4px 8px; border-radius: 3px; outline: none; }
  .send-bar select:focus, .send-bar input:focus { border-color: #555; }
  #input-to   { width: 120px; }
  #input-type { width: 90px; }
  #input-body { flex: 1; min-width: 180px; }
  .send-bar button { background: #2a4a6a; color: #90caf9; border: 1px solid #3a5a8a; font-family: monospace; font-size: 13px; padding: 4px 14px; border-radius: 3px; cursor: pointer; white-space: nowrap; }
  .send-bar button:hover { background: #2d527a; }
  .send-bar button:disabled { opacity: 0.5; cursor: default; }
  .send-error { color: var(--red); font-size: 12px; }
  .send-ok    { color: var(--green); font-size: 12px; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: var(--bg); }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
</style>
</head>
<body>
<header>
  <span class="title">Synapse</span>
  <span>
    <span class="status-dot" id="sse-dot"></span>
    <span class="status-label" id="sse-label">connecting…</span>
  </span>
</header>
<div class="main">
  <div class="panel-agents">
    <div class="panel-header">Agents</div>
    <div id="agent-table"><div class="agent-row" style="color:var(--text-muted)">loading…</div></div>
  </div>
  <div class="panel-messages">
    <div class="panel-header panel-header-row">
      <span>Messages</span>
      <span id="msg-count" style="color:var(--text-muted)">0</span>
    </div>
    <div id="msg-list"></div>
    <div class="send-bar">
      <label>To:</label>
      <select id="input-to"></select>
      <label>Type:</label>
      <select id="input-type">
        <option>TASK</option><option>STATUS</option><option>REVIEW</option><option>ACK</option><option>INFO</option>
      </select>
      <input type="text" id="input-body" placeholder="message body… (Ctrl+Enter to send)" autocomplete="off">
      <button id="send-btn">Send</button>
      <span id="send-feedback"></span>
    </div>
  </div>
</div>
<script>
(function () {
  const $ = id => document.getElementById(id);
  const agentTable = $('agent-table'), msgList = $('msg-list');
  const sseDot = $('sse-dot'), sseLabel = $('sse-label');
  const inputTo = $('input-to'), inputType = $('input-type'), inputBody = $('input-body');
  const sendBtn = $('send-btn'), feedback = $('send-feedback'), msgCount = $('msg-count');
  let totalMsgs = 0, knownAgents = [];

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function fmtTime(ts) {
    try {
      const d = new Date(ts.endsWith('Z') ? ts : ts + 'Z');
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { return ts; }
  }
  function flash(msg, ok) {
    feedback.className = ok ? 'send-ok' : 'send-error';
    feedback.textContent = msg;
    setTimeout(() => { feedback.textContent = ''; }, 3000);
  }

  function renderAgents(agents) {
    knownAgents = agents;
    const cur = inputTo.value;
    inputTo.innerHTML = '<option value="broadcast">broadcast</option>' +
      agents.map(a => '<option value="' + esc(a.window_name) + '">' + esc(a.window_name) + '</option>').join('');
    if (cur) inputTo.value = cur;

    if (!agents.length) {
      agentTable.innerHTML = '<div class="agent-row" style="color:var(--text-muted)">no agents</div>';
      return;
    }
    agentTable.innerHTML = agents.map(a => {
      const st = (a.status || 'unknown').toLowerCase();
      const dotCls = ['idle','busy','stopped'].includes(st) ? st : 'unknown';
      const badge = a.pending_count > 0 ? '<span class="agent-pending">' + a.pending_count + '</span>' : '';
      return '<div class="agent-row"><span class="agent-dot ' + dotCls + '"></span>' +
        '<span class="agent-name" title="' + esc(a.window_name) + '">' + esc(a.window_name) + '</span>' +
        '<span class="agent-role">' + esc(a.role || '') + '</span>' + badge + '</div>';
    }).join('');
  }

  function appendMessage(msg) {
    totalMsgs++;
    msgCount.textContent = totalMsgs;
    const t = (msg.type || '').toUpperCase();
    const row = document.createElement('div');
    row.className = 'msg-row';
    row.innerHTML =
      '<span class="msg-meta">' +
        '<span class="msg-id">#' + msg.id + '</span>' +
        '<span class="msg-route">' + esc(msg.from_agent) + ' → ' + esc(msg.to_agent) + '</span>' +
        '<span class="msg-type ' + esc(t) + '">' + esc(t) + '</span>' +
        (msg.status ? '<span class="msg-status">' + esc(msg.status) + '</span>' : '') +
      '</span>' +
      '<span class="msg-body">' + esc(msg.body || '') + '</span>' +
      '<span class="msg-time">' + fmtTime(msg.created_at || '') + '</span>';
    msgList.insertBefore(row, msgList.firstChild);
  }

  function connect() {
    const es = new EventSource('/events');
    es.addEventListener('agent-status', e => { try { renderAgents(JSON.parse(e.data)); } catch {} });
    es.addEventListener('message-stream', e => { try { appendMessage(JSON.parse(e.data)); } catch {} });
    es.onopen = () => { sseDot.className = 'status-dot connected'; sseLabel.textContent = 'connected'; };
    es.onerror = () => { sseDot.className = 'status-dot'; sseLabel.textContent = 'reconnecting…'; es.close(); setTimeout(connect, 2000); };
  }
  connect();

  async function sendMessage() {
    const to = inputTo.value.trim(), type = inputType.value, body = inputBody.value.trim();
    if (!to || !body) { flash('To and body required', false); return; }
    sendBtn.disabled = true; feedback.textContent = '';
    try {
      const res = await fetch('/send', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({to, type, body}) });
      const json = await res.json();
      if (json.ok) { inputBody.value = ''; flash('sent #' + json.id, true); }
      else flash(json.error || 'error', false);
    } catch (err) { flash(String(err), false); }
    finally { sendBtn.disabled = false; }
  }

  sendBtn.addEventListener('click', sendMessage);
  inputBody.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendMessage(); });
})();
</script>
</body>
</html>`;

const DEFAULT_UI_PORT = 7700;

function cmdUi(flags: Record<string, string>) {
  const port = flags["port"] ? parseInt(flags["port"], 10) : DEFAULT_UI_PORT;
  const db = connect();

  let lastMessageId = 0;
  // Seed last_id to current max so we only push new messages after startup.
  const maxRow = db
    .query("SELECT MAX(id) AS max_id FROM messages")
    .get() as any;
  if (maxRow?.max_id) lastMessageId = maxRow.max_id;

  // SSE client registry
  const clients = new Set<ReadableStreamDefaultController>();

  function pushToAll(eventName: string, data: unknown) {
    const chunk = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const ctrl of clients) {
      try {
        ctrl.enqueue(chunk);
      } catch {
        clients.delete(ctrl);
      }
    }
  }

  function pollDb() {
    // Agent status snapshot
    const agents = db
      .query(
        `SELECT window_name, role, status, last_seen_at,
                (SELECT COUNT(*) FROM messages m
                 WHERE m.status='pending'
                   AND (m.to_agent=a.window_name OR m.to_agent='broadcast')) AS pending_count
         FROM agents a
         ORDER BY role, window_name`,
      )
      .all();
    pushToAll("agent-status", agents);

    // New messages since last push
    const newMessages = db
      .query(
        `SELECT id, from_agent, to_agent, type, body, status, created_at
         FROM messages WHERE id > ? ORDER BY id`,
      )
      .all(lastMessageId) as any[];
    if (newMessages.length > 0) {
      lastMessageId = newMessages[newMessages.length - 1].id;
      for (const msg of newMessages) {
        pushToAll("message-stream", msg);
      }
    }
  }

  const pollTimer = setInterval(pollDb, 1000);

  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/" && req.method === "GET") {
        return new Response(FRONTEND_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/events" && req.method === "GET") {
        let ctrl: ReadableStreamDefaultController;
        const stream = new ReadableStream({
          start(c) {
            ctrl = c;
            clients.add(ctrl);
            // Send initial snapshot immediately
            pollDb();
          },
          cancel() {
            clients.delete(ctrl);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      if (url.pathname === "/send" && req.method === "POST") {
        return req
          .json()
          .then((body: any) => {
            const { to, type, body: msgBody } = body ?? {};
            if (!to || !type || !msgBody) {
              return Response.json(
                { ok: false, error: "missing to, type, or body" },
                { status: 400 },
              );
            }
            if (!MESSAGE_TYPES.has(type)) {
              return Response.json(
                {
                  ok: false,
                  error: `type must be one of ${[...MESSAGE_TYPES].sort()}`,
                },
                { status: 400 },
              );
            }
            if (to !== "broadcast") {
              const known = db
                .query("SELECT 1 FROM agents WHERE window_name=?")
                .get(to);
              if (!known) {
                console.error(
                  `synapse ui: warning — '${to}' not in agents registry (sending anyway)`,
                );
              }
            }
            const result = db.run(
              `INSERT INTO messages (from_agent, to_agent, type, body) VALUES ('ui', ?, ?, ?)`,
              [to, type, msgBody],
            );
            return Response.json({
              ok: true,
              id: Number(result.lastInsertRowid),
            });
          })
          .catch(() =>
            Response.json(
              { ok: false, error: "invalid JSON" },
              { status: 400 },
            ),
          );
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  const shutdown = () => {
    clearInterval(pollTimer);
    for (const ctrl of clients) {
      try {
        ctrl.close();
      } catch {}
    }
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(`synapse ui: listening on http://localhost:${port}`);
  console.log(`  GET  /        — dashboard`);
  console.log(`  GET  /events  — SSE stream (agent-status, message-stream)`);
  console.log(`  POST /send    — {to, type, body}`);
}

// ---------- arg parsing ----------

function parseFlags(args: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      // Boolean flag (--once): treat as true when no value follows or next is also a flag.
      if (next === undefined || next.startsWith("--")) {
        flags[key] = "true";
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseFlags(rest);

  switch (command) {
    case "init":
      return cmdInit();
    case "register": {
      const [name, role, sessionId] = positional;
      if (!name || !role)
        fail("usage: synapse register <name> <role> [session_id]");
      return cmdRegister(name, role, sessionId ?? null);
    }
    case "send": {
      const [to, type, body] = positional;
      if (!to || !type || !body)
        fail(
          "usage: synapse send <to> <type> <body> [--from NAME] [--ref-id N]",
        );
      const refId = flags["ref-id"] ? parseInt(flags["ref-id"], 10) : null;
      return cmdSend(to, type, body, flags["from"] ?? null, refId);
    }
    case "log": {
      const [agent, type, summary] = positional;
      if (!agent || !type || !summary)
        fail("usage: synapse log <agent> <type> <summary>");
      return cmdLog(agent, type, summary);
    }
    case "status":
      return cmdStatus();
    case "pending":
      return cmdPending(positional[0] ?? null);
    case "deliver": {
      const [id] = positional;
      if (!id) fail("usage: synapse deliver <id>");
      return cmdDeliver(parseInt(id, 10));
    }
    case "monitor":
      return cmdMonitor(flags);
    case "start": {
      const [configPath] = positional;
      if (!configPath)
        fail("usage: synapse start <team.yaml> [--goal TEXT] [--no-monitor]");
      return cmdStart(configPath, flags);
    }
    case "stop": {
      const [name] = positional;
      if (!name) fail("usage: synapse stop <name> [--session SESSION]");
      return cmdStop(name, flags["session"] ?? DEFAULT_TMUX_SESSION);
    }
    case "attach": {
      const [name] = positional;
      if (!name) fail("usage: synapse attach <name> [--session SESSION]");
      return cmdAttach(name, flags["session"] ?? DEFAULT_TMUX_SESSION);
    }
    case "ui":
      return cmdUi(flags);
    default:
      fail(
        `unknown command '${command}'. Expected one of: init, register, send, log, status, pending, deliver, monitor, start, stop, attach, ui`,
      );
  }
}

main();
