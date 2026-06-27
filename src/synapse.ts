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
      `synapse: no DB at ${path} — run \`synapse init\` first (or set SYNAPSE_DB).`
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
  reset:  "\x1b[0m",
  dim:    "\x1b[2m",
  blue:   "\x1b[34m",
  yellow: "\x1b[33m",
  green:  "\x1b[32m",
  cyan:   "\x1b[36m",
};
function colorType(t: string): string {
  const color = t === "TASK" ? c.blue : t === "REVIEW" ? c.yellow : t === "STATUS" ? c.green : c.cyan;
  return `${color}${t}${c.reset}`;
}

// ---------- commands ----------

// Returns schema version (0 = never set) and whether tables exist.
function probeSchema(db: Database): { version: number; hasTables: boolean } {
  const version = (db.query("PRAGMA user_version").get() as any).user_version as number;
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
        `DB at ${path} is schema v${version}, newer than this binary supports (v${SCHEMA_VERSION}). Upgrade synapse before running init.`
      );
    }
    if (hasTables && version < SCHEMA_VERSION) {
      // Move the whole data directory aside — it may also hold audit logs that
      // belong with the old DB, not mixed into the fresh one.
      const backupDir = `${dataDir}.v${version}.bak-${Date.now()}`;
      renameSync(dataDir, backupDir);
      console.log(
        `synapse: found pre-v${SCHEMA_VERSION} data (schema v${version}) at ${dataDir} — moved entire folder to ${backupDir}`
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
    [name, role, sessionId, nowIso()]
  );
  console.log(
    `synapse: registered '${name}' (role=${role}, session_id=${sessionId ?? "-"})`
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
  refId: number | null
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
        `synapse: warning — '${to}' not in agents registry yet (sending anyway)`
      );
    }
  }
  const result = db.run(
    `INSERT INTO messages (from_agent, to_agent, type, ref_id, body)
     VALUES (?, ?, ?, ?, ?)`,
    [frm, to, type, refId, body]
  );
  console.log(
    `synapse: message ${result.lastInsertRowid} queued (${frm} -> ${to}, ${type}${
      refId ? ", ref=" + refId : ""
    })`
  );
}

function cmdLog(agent: string, type: string, summary: string) {
  if (!EVENT_TYPES.has(type)) {
    console.error(
      `synapse: warning — '${type}' is outside the suggested vocab ${[
        ...EVENT_TYPES,
      ].sort()} (logging anyway)`
    );
  }
  const db = connect();
  const result = db.run(
    "INSERT INTO events (agent, type, summary) VALUES (?, ?, ?)",
    [agent, type, summary]
  );
  console.log(`synapse: event ${result.lastInsertRowid} logged (${agent}, ${type})`);
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
     AND (to_agent=? OR to_agent='broadcast')`
  );
  const headers = ["WINDOW", "ROLE", "STATUS", "SESSION_ID", "LAST_SEEN", "PENDING"];
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
    Math.max(h.length, ...rows.map((r) => r[i].length))
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
           AND (to_agent=? OR to_agent='broadcast') ORDER BY created_at`
        )
        .all(agent) as any[])
    : (db
        .query("SELECT * FROM messages WHERE status='pending' ORDER BY created_at")
        .all() as any[]);
  if (rows.length === 0) {
    console.log("synapse: no pending messages");
    return;
  }
  const agentW = Math.max(...rows.flatMap(r => [r.from_agent.length, r.to_agent.length]));
  const typeW  = Math.max(...rows.map(r => r.type.length));
  const refW   = Math.max(...rows.map(r => r.ref_id ? `ref:#${r.ref_id}`.length : 0));
  for (const r of rows) {
    const route = `${r.from_agent.padEnd(agentW)} → ${r.to_agent.padEnd(agentW)}`;
    const type  = colorType(r.type) + " ".repeat(typeW - r.type.length);
    const refRaw = r.ref_id ? `ref:#${r.ref_id}` : "";
    const ref   = refRaw ? `${c.dim}${refRaw}${c.reset}` + " ".repeat(refW - refRaw.length) : " ".repeat(refW);
    const ts    = `${c.dim}${r.created_at.slice(0, 16)}${c.reset}`;
    const id    = `${c.dim}#${String(r.id).padStart(2)}${c.reset}`;
    console.log(`${id}  ${route}  ${type}  ${ref}  ${ts}`);
    console.log(`      ${r.body}`);
    console.log();
  }
}

function cmdDeliver(id: number) {
  const db = connect();
  const result = db.run(
    "UPDATE messages SET status='delivered', delivered_at=? WHERE id=? AND status='pending'",
    [nowIso(), id]
  );
  if (result.changes === 0) fail(`no pending message with id=${id}`);
  console.log(`synapse: message ${id} marked delivered`);
}

// ---------- monitor ----------

type IdleState = "idle" | "busy" | "unknown";
type IdleStateResult = {
  state: IdleState;
  detail: string;
  recheckAfterMs?: number;
};

// Globs $CLAUDE_PROJECTS_DIR for the session's .jsonl instead of
// reconstructing the project-slug encoding — session id is unique enough.
function findTranscriptPath(sessionId: string): string | null {
  const root = process.env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
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
function deriveIdleStateFromTranscript(
  sessionId: string,
  debounceMs: number
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
      recheckAfterMs: debounceMs - ageMs,
    };
  }
  return { state: "idle", detail: `end_turn, quiet for ${Math.round(ageMs)}ms` };
}

function tmuxSendKeys(
  session: string,
  window: string,
  body: string
): { ok: boolean; error?: string } {
  const target = `${session}:${window}`;
  // -l forces literal text; without it a body that matches a key name (e.g. "Enter") gets
  // consumed as that keypress. Enter is sent separately so it's always a real keypress.
  let result = Bun.spawnSync(["tmux", "send-keys", "-t", target, "-l", "--", body]);
  if (result.exitCode !== 0) {
    const stderr = result.stderr?.toString().trim();
    return { ok: false, error: stderr || `tmux send-keys exited ${result.exitCode}` };
  }
  result = Bun.spawnSync(["tmux", "send-keys", "-t", target, "Enter"]);
  if (result.exitCode !== 0) {
    const stderr = result.stderr?.toString().trim();
    return { ok: false, error: stderr || `tmux send-keys (Enter) exited ${result.exitCode}` };
  }
  return { ok: true };
}

function dispatchDirectMessage(
  db: Database,
  tmuxSession: string,
  windowName: string,
  msg: any,
  log: (s: string) => void
) {
  const res = tmuxSendKeys(tmuxSession, windowName, msg.body);
  if (res.ok) {
    db.run("UPDATE messages SET status='delivered', delivered_at=? WHERE id=?", [
      nowIso(),
      msg.id,
    ]);
    log(`  [${msg.id}] ${msg.from_agent} -> ${windowName} (${msg.type}) delivered`);
  } else {
    // Delivery failures are terminal in v1. Operators can inspect failed rows;
    // automatic retry would need retry_count/next_retry_at plus a redelivery path.
    db.run("UPDATE messages SET status='failed' WHERE id=?", [msg.id]);
    log(`  [${msg.id}] ${msg.from_agent} -> ${windowName} (${msg.type}) FAILED: ${res.error}`);
  }
}

// Dispatches the oldest pending direct message for windowName, if any.
function dispatchNextDirectMessage(
  db: Database,
  tmuxSession: string,
  windowName: string,
  log: (s: string) => void
) {
  const msg = db
    .query(
      `SELECT * FROM messages WHERE status='pending' AND to_agent=?
       ORDER BY created_at LIMIT 1`
    )
    .get(windowName) as any;
  if (msg) dispatchDirectMessage(db, tmuxSession, windowName, msg, log);
}

function hasPendingDirectMessageForWindow(db: Database, windowName: string): boolean {
  const row = db
    .query(
      `SELECT 1 FROM messages WHERE status='pending' AND to_agent=? LIMIT 1`
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
  log: (s: string) => void
) {
  const broadcasts = db
    .query(`SELECT * FROM messages WHERE status='pending' AND to_agent='broadcast' ORDER BY created_at`)
    .all() as any[];
  for (const msg of broadcasts) {
    const recipients = agents.filter((a) => a.window_name !== msg.from_agent);
    if (recipients.length === 0) continue;
    const allIdle = recipients.every((a) => idleStates.get(a.window_name) === "idle");
    if (!allIdle) continue;
    let allOk = true;
    for (const r of recipients) {
      const res = tmuxSendKeys(tmuxSession, r.window_name, msg.body);
      log(
        `  broadcast[${msg.id}] ${msg.from_agent} -> ${r.window_name}: ${
          res.ok ? "delivered" : "FAILED: " + res.error
        }`
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

// Evaluates one agent's transcript-derived readiness and persists the transition.
// idleStates acts as both prev-state tracker and the snapshot broadcastReadyMessages reads.
function evaluateAgentReadiness(
  db: Database,
  debounceMs: number,
  agent: any,
  idleStates: Map<string, IdleState>,
  log: (s: string) => void
): IdleStateResult | null {
  const result = deriveIdleStateFromTranscript(agent.session_id, debounceMs);
  const { state, detail } = result;
  const prev = idleStates.get(agent.window_name) ?? agent.status;
  idleStates.set(agent.window_name, state);
  if (state === "unknown") {
    log(`  ${agent.window_name}: unknown (${detail})`);
    return result;
  }
  if (state !== prev) {
    log(`  ${agent.window_name}: ${prev} -> ${state} (${detail})`);
  }
  // Guarded so a concurrent deregister wins — don't resurrect a stopped row.
  const update = db.run(
    "UPDATE agents SET status=?, last_seen_at=? WHERE window_name=? AND status != 'stopped'",
    [state, nowIso(), agent.window_name]
  );
  if (update.changes === 0) {
    idleStates.delete(agent.window_name);
    log(`  ${agent.window_name}: stopped before readiness update`);
    return null;
  }

  return result;
}

// Single synchronous snapshot — evaluate every live agent, then broadcast if ready.
function pollOnce(
  db: Database,
  tmuxSession: string,
  debounceMs: number,
  log: (s: string) => void
) {
  const agents = db
    .query("SELECT * FROM agents WHERE status != 'stopped' AND session_id IS NOT NULL")
    .all() as any[];
  const idleStates = new Map<string, IdleState>();
  for (const agent of agents) {
    const result = evaluateAgentReadiness(
      db,
      debounceMs,
      agent,
      idleStates,
      log
    );
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
      fsWatch(path, () => this.emitChange(key))
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

  checkAndEmitChange(key: string): void {
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
  log: (s: string) => void
) {
  const idleStates = new Map<string, IdleState>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let agents: any[] = [];
  let agentsByWindow = new Map<string, any>();

  const refreshAgents = () => {
    agents = db
      .query("SELECT * FROM agents WHERE status != 'stopped' AND session_id IS NOT NULL")
      .all() as any[];
    agentsByWindow = new Map(agents.map((a) => [a.window_name, a]));
  };

  const evaluateWindowReadiness = (windowName: string) => {
    const agent = agentsByWindow.get(windowName);
    if (!agent) return null; // deregistered/stopped between event and update
    return evaluateAgentReadiness(
      db,
      debounceMs,
      agent,
      idleStates,
      log
    );
  };

  const attemptDelivery = (windowName: string) => {
    const result = evaluateWindowReadiness(windowName);
    if (result?.state === "idle") {
      dispatchNextDirectMessage(db, tmuxSession, windowName, log);
      broadcastReadyMessages(db, tmuxSession, agents, idleStates, log);
    } else if (
      result?.recheckAfterMs !== undefined &&
      hasPendingDirectMessageForWindow(db, windowName)
    ) {
      scheduleDeliveryAttempt(windowName, result.recheckAfterMs);
    }
  };

  const cancelScheduledDeliveryAttempt = (windowName: string) => {
    const existing = debounceTimers.get(windowName);
    if (existing) clearTimeout(existing);
    debounceTimers.delete(windowName);
  };

  const scheduleDeliveryAttempt = (windowName: string, delayMs: number) => {
    debounceTimers.set(
      windowName,
      setTimeout(() => {
        debounceTimers.delete(windowName);
        attemptDelivery(windowName);
      }, Math.max(0, delayMs))
    );
  };

  const onTranscriptActivity = (windowName: string) => {
    cancelScheduledDeliveryAttempt(windowName);
    attemptDelivery(windowName);
  };

  const pool = new FileWatchPool((windowName) => onTranscriptActivity(windowName));

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
    `synapse monitor: watching tmux session '${tmuxSession}' via fs.watch (debounce=${debounceMs}ms, mail-sweep=${sweepMs}ms)`
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
      cancelScheduledDeliveryAttempt(name);
      log(`  ${name}: stopped, cleanup`);
    }
    for (const agent of agents) {
      // Mail can arrive without transcript activity.
      if (idleStates.get(agent.window_name) === "idle") {
        dispatchNextDirectMessage(db, tmuxSession, agent.window_name, log);
      }
      if (pool.isWatching(agent.window_name)) {
        pool.checkAndEmitChange(agent.window_name);
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
      if (current && current.name && current.role && current.cwd) agents.push(current as AgentConfig);
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
  if (current && current.name && current.role && current.cwd) agents.push(current as AgentConfig);

  if (!session) fail("team.yaml: missing 'session' field");
  if (agents.length === 0) fail("team.yaml: no agents defined");
  return { session, agents };
}

// Polls the pane for a session-id file written by the launch wrapper.
// The wrapper is: `cd <cwd> && claude` piped through a shim that captures the
// session id from the session-start banner and writes it to
// .synapse/<name>.session-id within SYNAPSE_DB's directory.
// We wait up to timeoutMs for the file to appear.
function waitForSessionId(
  sessionIdFile: string,
  timeoutMs: number,
  intervalMs = 500
): string | null {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(sessionIdFile)) {
      const content = readFileSync(sessionIdFile, "utf8").trim();
      if (content.length > 0) return content;
    }
    // Bun synchronous sleep
    Bun.sleepSync(intervalMs);
  }
  return null;
}

// Launches one agent window in the tmux session.
// The window runs a small shell snippet that starts claude, captures the
// session id from the "Starting session <id>" banner, writes it to a file,
// and then hands off stdin/stdout to the claude process normally.
function launchAgentWindow(
  tmuxSession: string,
  agent: AgentConfig,
  sessionIdFile: string,
  synapseDb: string,
  synapseCliPath: string
): void {
  // Shell snippet:
  //   1. cd to agent's working directory.
  //   2. Start claude, tee its initial output to a temp file.
  //   3. Extract the session id from the banner line.
  //   4. Write the session id to sessionIdFile.
  //   5. The process continues running as the claude session.
  //
  // We use script(1) + grep trick: start claude with its output going to a
  // named pipe; a background subshell reads the pipe, grabs the session id,
  // writes the file, then discards. The main shell then exec's into claude
  // directly so the pane behaves normally from that point on.
  const absSessionIdFile = resolve(sessionIdFile);
  const absCwd = resolve(agent.cwd);
  const shellCmd = [
    `cd '${absCwd}'`,
    // Create a shell function that starts claude, captures the session id
    // from stdout, and writes it to the session-id file. We do this by
    // running claude with its stdout going through a tee to a fifo, then
    // forwarding to the pane's stdout. A background subshell reads the fifo,
    // extracts the session id, writes the file, then exits.
    `_fifo=$(mktemp -u)`,
    `mkfifo "$_fifo"`,
    // Background reader: grab the first matching banner line
    `( grep -m1 'Starting session' < "$_fifo" | sed 's/.*Starting session //' | tr -d '\\r\\n' > '${absSessionIdFile}'; rm -f "$_fifo" ) &`,
    // Start claude, tee to the fifo so the bg reader sees banner, and also
    // output normally to the pane via stdout.
    `SYNAPSE_DB='${synapseDb}' SYNAPSE_AGENT='${agent.name}' claude | tee "$_fifo"`,
  ].join(" && ");

  const result = Bun.spawnSync([
    "tmux", "new-window",
    "-t", tmuxSession,
    "-n", agent.name,
    "--",
    "bash", "-c", shellCmd,
  ]);
  if (result.exitCode !== 0) {
    fail(`failed to create tmux window '${agent.name}': ${result.stderr.toString().trim()}`);
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
    [nowIso()]
  );

  // Create tmux session (fail gracefully if it exists)
  const sessionExists = Bun.spawnSync(["tmux", "has-session", "-t", config.session]);
  if (sessionExists.exitCode !== 0) {
    const newSession = Bun.spawnSync(["tmux", "new-session", "-d", "-s", config.session]);
    if (newSession.exitCode !== 0) {
      fail(`failed to create tmux session '${config.session}': ${newSession.stderr.toString().trim()}`);
    }
    // Rename the default window created with the session
    Bun.spawnSync(["tmux", "rename-window", "-t", `${config.session}:0`, "monitor"]);
  } else {
    console.log(`synapse: tmux session '${config.session}' already exists — reusing`);
  }

  // Check if agents are already registered (idempotent re-start)
  const agentNames = config.agents.map((a) => a.name);
  const placeholders = agentNames.map(() => "?").join(",");
  const existing = (db.query(
    `SELECT window_name FROM agents WHERE window_name IN (${placeholders}) AND status != 'stopped'`
  ).all(...agentNames) as any[]).map((r) => r.window_name);

  if (existing.length === agentNames.length) {
    console.log(`synapse: team '${config.session}' already running — reusing existing agents`);
    console.log(`  Attach: tmux attach -t ${config.session}`);
    console.log(`  Status: synapse status`);
    return;
  }

  // Launch each agent window and capture session ids
  const sessionIdFiles: Map<string, string> = new Map();
  const synapseCliPath = resolve(process.execPath === process.argv[0]
    ? process.argv[1]   // running via bun src/synapse.ts
    : process.execPath  // compiled binary
  );

  for (const agent of config.agents) {
    const sessionIdFile = join(dataDir, `${agent.name}.session-id`);
    sessionIdFiles.set(agent.name, sessionIdFile);
    console.log(`synapse: launching window '${agent.name}' (${agent.role}) in ${agent.cwd}`);
    launchAgentWindow(config.session, agent, sessionIdFile, dbFile, synapseCliPath);
  }

  // Wait for each session id and register
  const SESSION_ID_TIMEOUT_MS = 30_000;
  for (const agent of config.agents) {
    const file = sessionIdFiles.get(agent.name)!;
    console.log(`synapse: waiting for session id from '${agent.name}'...`);
    const sessionId = waitForSessionId(file, SESSION_ID_TIMEOUT_MS);
    if (!sessionId) {
      console.error(
        `synapse: warning — timed out waiting for session id from '${agent.name}' (${SESSION_ID_TIMEOUT_MS}ms). Registering without session id.`
      );
      cmdRegister(agent.name, agent.role, null);
    } else {
      console.log(`synapse: '${agent.name}' session id: ${sessionId}`);
      cmdRegister(agent.name, agent.role, sessionId);
    }
  }

  // Start monitor in the 'monitor' tmux window
  if (!noMonitor) {
    const monitorCmd = `SYNAPSE_DB='${dbFile}' ${synapseCliPath} monitor --session ${config.session}`;
    const r = Bun.spawnSync([
      "tmux", "send-keys", "-t", `${config.session}:monitor`, monitorCmd, "Enter",
    ]);
    if (r.exitCode !== 0) {
      console.error(`synapse: warning — failed to start monitor: ${r.stderr.toString().trim()}`);
    } else {
      console.log(`synapse: monitor started in window '${config.session}:monitor'`);
    }
  }

  // Send initial goal as TASK from operator to first planner agent, if provided
  if (goal) {
    const planner = config.agents.find((a) => a.role === "planner");
    if (!planner) {
      console.error("synapse: warning — no planner agent found; cannot send initial goal");
    } else {
      cmdSend(planner.name, "TASK", goal, "operator", null);
      console.log(`synapse: initial goal queued as TASK to '${planner.name}'`);
    }
  }

  console.log(`synapse: team '${config.session}' started with ${config.agents.length} agent(s)`);
  console.log(`  Attach: tmux attach -t ${config.session}`);
  console.log(`  Status: synapse status`);
}

function cmdStop(name: string, tmuxSession: string) {
  const db = connect();
  const agent = db.query("SELECT * FROM agents WHERE window_name=?").get(name) as any;
  if (!agent) fail(`no registered agent named '${name}'`);

  db.run("UPDATE agents SET status='stopped', last_seen_at=? WHERE window_name=?", [
    nowIso(),
    name,
  ]);

  const killResult = Bun.spawnSync(["tmux", "kill-window", "-t", `${tmuxSession}:${name}`]);
  if (killResult.exitCode !== 0) {
    const stderr = killResult.stderr.toString().trim();
    console.error(`synapse: warning — tmux kill-window failed: ${stderr}`);
  }
  console.log(`synapse: agent '${name}' stopped`);
}

function cmdAttach(name: string, tmuxSession: string) {
  const result = Bun.spawnSync(
    ["tmux", "attach-session", "-t", `${tmuxSession}:${name}`],
    { stdio: ["inherit", "inherit", "inherit"] }
  );
  if (result.exitCode !== 0) {
    fail(`tmux attach failed: ${result.stderr?.toString().trim()}`);
  }
}

function cmdMonitor(flags: Record<string, string>) {
  const tmuxSession = flags["session"] ?? DEFAULT_TMUX_SESSION;
  const sweepMs = flags["interval"] ? parseInt(flags["interval"], 10) : DEFAULT_SWEEP_INTERVAL_MS;
  const debounceMs = flags["debounce"] ? parseInt(flags["debounce"], 10) : DEFAULT_DEBOUNCE_MS;
  const once = flags["once"] === "true";

  const db = connect();
  const log = (s: string) => console.log(`[${nowIso()}] ${s}`);

  if (once) {
    pollOnce(db, tmuxSession, debounceMs, log);
    return;
  }

  runLiveMonitor(db, tmuxSession, debounceMs, sweepMs, log);
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
      if (!name || !role) fail("usage: synapse register <name> <role> [session_id]");
      return cmdRegister(name, role, sessionId ?? null);
    }
    case "send": {
      const [to, type, body] = positional;
      if (!to || !type || !body)
        fail("usage: synapse send <to> <type> <body> [--from NAME] [--ref-id N]");
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
      if (!configPath) fail("usage: synapse start <team.yaml> [--goal TEXT] [--no-monitor]");
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
    default:
      fail(
        `unknown command '${command}'. Expected one of: init, register, send, log, status, pending, deliver, monitor, start, stop, attach`
      );
  }
}

main();
