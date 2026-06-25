#!/usr/bin/env bun
/**
 * synapse — CLI for the Claude Team Synapse message bus.
 *
 * Implements, per synapse-spec.md section "Execution plan / Phase 0":
 *   synapse register <name> <role> [session_id]
 *   synapse send <to> <type> <body> [--from NAME] [--ref-id N]
 *   synapse log <agent> <type> <summary>
 *   synapse status
 *
 * Phase 1 (manual delivery loop, no monitor):
 *   synapse pending [agent]      list pending messages, optionally filtered
 *   synapse deliver <id>         mark a message delivered (after manual send-keys)
 *
 * Phase 2 (idle detection + automated delivery, see synapse-spec.md sections
 * 3 and 4, and "Execution plan / Phase 2"):
 *   synapse monitor [--session NAME] [--interval MS] [--debounce MS] [--once]
 *     Classifies every registered, non-stopped agent's Claude Code session
 *     transcript idle/busy (last assistant `stop_reason`, debounced against
 *     transcript activity) and on an idle transition with pending mail
 *     delivers the oldest pending message via `tmux send-keys`, marking it
 *     delivered (or failed if the tmux target is gone).
 *
 *     The long-lived loop (no `--once`) is event-driven per
 *     synapse-spec.md section 3's "tail -f or inotify watch" — it uses
 *     `fs.watch` on each agent's transcript and reacts to writes instead of
 *     re-reading every agent's (potentially large, ever-growing) transcript
 *     on a fixed timer. `--debounce` is the idle-confirmation window (must
 *     be quiet this long after an `end_turn` before delivering); `--interval`
 *     is a separate, much cheaper periodic sweep that only touches the
 *     `agents`/`messages` tables, not the filesystem — it picks up agents
 *     registered after the monitor started, attaches a watcher once a
 *     transcript that didn't exist yet appears, and re-checks pending mail
 *     for an agent that was already idle (a message arriving via
 *     `synapse send` produces no transcript write for the watcher to react
 *     to, so something still has to poll the mailbox itself — just not the
 *     transcripts). `--once` runs a single synchronous snapshot instead of
 *     starting any of that — used by the monitor's own tests and for manual
 *     one-shot delivery.
 *
 * Transcript location is resolved by globbing
 * `$CLAUDE_PROJECTS_DIR/*<sessionId>.jsonl` (default
 * `$CLAUDE_PROJECTS_DIR/<project-slug>/<sessionId>.jsonl`, falling back to
 * `~/.claude/projects`) rather than reconstructing the project-slug encoding
 * of cwd — the session id is already a unique filename, so this is more
 * robust to slug-encoding edge cases and lets tests point at a throwaway
 * directory via the env var.
 *
 * No tmux automation for anything other than `monitor`'s delivery step —
 * the rest only talks to SQLite. Run `synapse init` once to create the DB
 * before anything else.
 *
 * DB location: $SYNAPSE_DB env var, else ./.synapse/synapse.db relative to cwd.
 *
 * Run with `bun src/synapse.ts <command> ...`, or compile a standalone binary:
 *   bun build src/synapse.ts --compile --outfile synapse
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
// Imported as text (not read from disk at runtime) so this also works from
// a `bun build --compile` standalone binary, which has no schema.sql beside it.
import SCHEMA_SQL from "./schema.sql" with { type: "text" };

// Closed vocab per synapse-spec.md sections 2 and 5.
const MESSAGE_TYPES = new Set(["TASK", "STATUS", "REVIEW", "ACK", "INFO"]);
const EVENT_TYPES = new Set(["task_start", "task_end", "decision"]);

// Phase 2 (monitor) defaults — synapse-spec.md sections 3, 4 and "Execution
// plan / Phase 2". All overridable via CLI flags.
const DEFAULT_TMUX_SESSION = "team";
// Cheap mailbox/roster sweep only (no transcript reads) — see header comment.
// Idle detection itself is event-driven, not on this timer.
const DEFAULT_SWEEP_INTERVAL_MS = 200;
const DEFAULT_DEBOUNCE_MS = 2000;

// Bumped whenever the schema changes in a way that needs a migration check
// on `init`. Stored in the DB's own `PRAGMA user_version` (a free integer
// SQLite reserves for exactly this) rather than a table, so detection works
// even before any table exists.
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

// ---------- commands ----------

// Returns the schema version of an already-open DB (0 if never set — either
// a brand-new empty file, or a pre-versioning DB from before this check
// existed) and whether it actually has tables yet (distinguishes those two
// "version 0" cases).
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
      // Move the whole data directory aside, not just the DB file — it may
      // also hold audit logs etc. (see synapse-spec.md section 5) that
      // belong with that old DB, not mixed into the fresh one below.
      const backupDir = `${dataDir}.v${version}.bak-${Date.now()}`;
      renameSync(dataDir, backupDir);
      console.log(
        `synapse: found pre-v${SCHEMA_VERSION} data (schema v${version}) at ${dataDir} — moved entire folder to ${backupDir}`
      );
    }
    // hasTables===false (untouched empty file) or already current version:
    // fall through, schema creation below is idempotent.
  }

  mkdirSync(dataDir, { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
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
  for (const r of rows) {
    const ref = r.ref_id ? ` ref=${r.ref_id}` : "";
    console.log(
      `[${r.id}] ${r.from_agent} -> ${r.to_agent} (${r.type}${ref}) @ ${r.created_at}\n    ${r.body}`
    );
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

// ---------- monitor (Phase 2) ----------

type IdleState = "idle" | "busy" | "unknown";

// Locates the jsonl transcript for a Claude Code session id without
// reconstructing the project-slug encoding of cwd — see header comment.
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

// Scans backward (transcripts are append-only, so the answer is near the
// end) for the last well-formed `assistant` entry's `message.stop_reason`.
// Tolerates a partially-written final line (the writer may be mid-append).
function lastAssistantStopReason(path: string): string | null {
  const lines = readFileSync(path, "utf8").split("\n");
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

// Idle = last assistant entry has stop_reason "end_turn" AND no new jsonl
// lines for `debounceMs` (synapse-spec.md section 3). Anything else
// (tool_use, no transcript yet, no assistant turn yet) is not idle.
function readIdleState(
  sessionId: string,
  debounceMs: number
): { state: IdleState; detail: string } {
  const path = findTranscriptPath(sessionId);
  if (!path) return { state: "unknown", detail: "no transcript found yet" };

  const stopReason = lastAssistantStopReason(path);
  if (!stopReason) return { state: "unknown", detail: "no assistant turn yet" };

  if (stopReason !== "end_turn") {
    return { state: "busy", detail: `stop_reason=${stopReason}` };
  }

  const ageMs = Date.now() - statSync(path).mtimeMs;
  if (ageMs < debounceMs) {
    return { state: "busy", detail: `end_turn, debouncing (${Math.round(ageMs)}ms)` };
  }
  return { state: "idle", detail: `end_turn, quiet for ${Math.round(ageMs)}ms` };
}

function tmuxSendKeys(
  session: string,
  window: string,
  body: string
): { ok: boolean; error?: string } {
  const target = `${session}:${window}`;
  // -l forces literal interpretation of `body`, and `--` stops option
  // parsing so a body starting with "-" isn't mistaken for a flag. Verified
  // against a real tmux pane: without -l, a body that happens to exactly
  // match a key name (e.g. a message body of literally "Enter") gets
  // swallowed as that keypress instead of typed out as text. Enter itself
  // is sent as a separate call so it's interpreted as the actual key.
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

function deliverDirect(
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
    db.run("UPDATE messages SET status='failed' WHERE id=?", [msg.id]);
    log(`  [${msg.id}] ${msg.from_agent} -> ${windowName} (${msg.type}) FAILED: ${res.error}`);
  }
}

// Delivers the oldest pending direct (non-broadcast) message addressed to
// `windowName`, if any. Shared by the --once snapshot path and the live
// loop's cheap mail sweep.
function deliverPendingDirect(
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
  if (msg) deliverDirect(db, tmuxSession, windowName, msg, log);
}

// Broadcasts are a known simplification (see synapse-spec.md open questions
// on broadcast fan-out): a single `messages` row can't represent "delivered
// to A, not yet to B", so a broadcast only fires once every other live,
// non-sender agent is observed idle *at the same instant this runs*; until
// then nothing goes out to anyone, rather than risk silently skipping a busy
// recipient. Called after any agent's idle state may have changed.
function checkBroadcasts(
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

// Classifies one agent's current transcript state, persists the transition,
// and — on an idle result — delivers its oldest pending direct message.
// `idleStates` doubles as "previous state" for transition logging (falling
// back to the DB row's `status` the first time an agent is seen) and as the
// snapshot `checkBroadcasts` reads, so callers update it before consulting
// broadcasts. Shared by the --once snapshot and every live-loop evaluation —
// there is exactly one place that decides idle/busy.
function evaluateAgentOnce(
  db: Database,
  tmuxSession: string,
  debounceMs: number,
  agent: any,
  idleStates: Map<string, IdleState>,
  log: (s: string) => void
) {
  const { state, detail } = readIdleState(agent.session_id, debounceMs);
  const prev = idleStates.get(agent.window_name) ?? agent.status;
  idleStates.set(agent.window_name, state);
  if (state === "unknown") {
    log(`  ${agent.window_name}: unknown (${detail})`);
    return;
  }
  if (state !== prev) {
    log(`  ${agent.window_name}: ${prev} -> ${state} (${detail})`);
  }
  db.run("UPDATE agents SET status=?, last_seen_at=? WHERE window_name=?", [
    state,
    nowIso(),
    agent.window_name,
  ]);

  if (state === "idle") deliverPendingDirect(db, tmuxSession, agent.window_name, log);
}

// `--once`: a single synchronous snapshot — evaluate every live agent, then
// check broadcasts once. Used by tests and manual one-off delivery, where
// there's nothing to wait for in a one-shot invocation.
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
    evaluateAgentOnce(db, tmuxSession, debounceMs, agent, idleStates, log);
  }
  checkBroadcasts(db, tmuxSession, agents, idleStates, log);
}

// Generic "reliably tell me when one of these named files changes" pool —
// deliberately knows nothing about agents, idle states, or delivery. It
// exists because raw fs.watch turned out not to be trustworthy on its own:
// confirmed empirically (see tests/monitor.test.ts's live-loop describe
// block) that it silently drops events on some filesystems/mounts. So each
// watched key gets both an fs.watch listener (fast path) and is eligible for
// recheckAll()'s metadata-only staleness check (reliability backstop) — a
// caller just gets one onChange(key, path) callback either way and never
// has to know which path fired it. Centralizing this here is what let
// runLiveMonitor drop three of its four bookkeeping maps.
class FileWatchPool {
  private watchers = new Map<string, ReturnType<typeof fsWatch>>();
  private paths = new Map<string, string>();
  private mtimes = new Map<string, number>();

  constructor(private onChange: (key: string, path: string) => void) {}

  // No-op if `key` is already watched (idempotent re-attach attempts, e.g.
  // from a sweep that hasn't learned a watcher already exists, are safe).
  // Fires onChange once immediately so callers don't need a separate
  // "evaluate the initial state" step before/around watch().
  watch(key: string, path: string): void {
    if (this.watchers.has(key)) return;
    this.paths.set(key, path);
    this.recordMtime(key, path);
    this.watchers.set(
      key,
      fsWatch(path, () => this.fire(key))
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

  // Metadata-only (no transcript content read) staleness check across every
  // watched key — safe to call on every sweep tick regardless of how large
  // the underlying files are. Fires onChange for any key whose mtime moved
  // since it was last recorded without fs.watch already having reported it.
  recheckAll(): void {
    for (const [key, path] of this.paths) {
      let mtime: number;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (mtime !== this.mtimes.get(key)) this.fire(key);
    }
  }

  closeAll(): void {
    for (const key of [...this.watchers.keys()]) this.unwatch(key);
  }

  private fire(key: string): void {
    const path = this.paths.get(key);
    if (!path) return;
    this.recordMtime(key, path);
    this.onChange(key, path);
  }

  private recordMtime(key: string, path: string): void {
    try {
      this.mtimes.set(key, statSync(path).mtimeMs);
    } catch {
      // File briefly unreadable (mid-write/rotate) — the next real event
      // or recheckAll() will retry.
    }
  }
}

// The long-lived monitor loop: event-driven idle detection (synapse-spec.md
// section 3's "tail -f or inotify watch") via FileWatchPool, plus a cheap
// periodic sweep for the things a file watch can't tell us — see header
// comment for the split between debounceMs (idle confirmation) and sweepMs
// (mailbox/roster polling + the watch pool's reliability backstop, both
// deliberately cheap since neither reads a transcript).
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

  const evaluate = (windowName: string) => {
    const agent = agentsByWindow.get(windowName);
    if (!agent) return; // deregistered/stopped between the event firing and now
    evaluateAgentOnce(db, tmuxSession, debounceMs, agent, idleStates, log);
    if (idleStates.get(windowName) === "idle") {
      checkBroadcasts(db, tmuxSession, agents, idleStates, log);
    }
  };

  // (Re)arms the idle-confirmation timer for debounceMs of quiet measured
  // from the transcript's own mtime — not just "debounceMs from whenever
  // this happened to be called" — so a burst of rapid writes collapses into
  // one evaluation instead of restarting a full debounceMs on every event,
  // and the very first arm-up after a watch attaches correctly accounts for
  // time the transcript already sat quiet before the watcher existed.
  const scheduleConfirm = (windowName: string, transcriptPath: string) => {
    const existing = debounceTimers.get(windowName);
    if (existing) clearTimeout(existing);
    let ageMs = 0;
    try {
      ageMs = Date.now() - statSync(transcriptPath).mtimeMs;
    } catch {
      // Transcript briefly unreadable (rotated mid-write?) — the next
      // change event or sweep will re-evaluate.
    }
    const remaining = Math.max(0, debounceMs - ageMs);
    debounceTimers.set(
      windowName,
      setTimeout(() => {
        debounceTimers.delete(windowName);
        evaluate(windowName);
      }, remaining)
    );
  };

  const pool = new FileWatchPool((windowName, path) => {
    evaluate(windowName);
    scheduleConfirm(windowName, path);
  });

  const sweep = () => {
    refreshAgents();
    const liveNames = new Set(agents.map((a) => a.window_name));
    for (const name of idleStates.keys()) {
      if (liveNames.has(name)) continue;
      pool.unwatch(name);
      idleStates.delete(name);
      const t = debounceTimers.get(name);
      if (t) clearTimeout(t);
      debounceTimers.delete(name);
      log(`  ${name}: stopped, watcher closed`);
    }
    for (const agent of agents) {
      if (pool.isWatching(agent.window_name)) continue;
      // No watcher yet, either because the agent was just registered or
      // because its transcript hadn't been written yet last sweep —
      // fs.watch needs an existing path, so this existence check (cheap:
      // a directory listing, not a file read) is the bridge until then.
      const path = findTranscriptPath(agent.session_id);
      if (path) {
        pool.watch(agent.window_name, path);
        log(`  ${agent.window_name}: watching ${path}`);
      }
    }
    // fs.watch backstop: catches any change the watchers above missed (see
    // FileWatchPool's header comment) — metadata-only, so this stays cheap
    // regardless of transcript size.
    pool.recheckAll();
    for (const agent of agents) {
      if (idleStates.get(agent.window_name) === "idle") {
        deliverPendingDirect(db, tmuxSession, agent.window_name, log);
      }
    }
    checkBroadcasts(db, tmuxSession, agents, idleStates, log);
  };

  sweep();
  const sweepTimer = setInterval(sweep, sweepMs);

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(sweepTimer);
    for (const t of debounceTimers.values()) clearTimeout(t);
    pool.closeAll();
    log("synapse monitor: stopped");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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

  log(
    `synapse monitor: watching tmux session '${tmuxSession}' via fs.watch (debounce=${debounceMs}ms, mail-sweep=${sweepMs}ms)`
  );
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
      // Boolean flag (e.g. --once): no value, or the next token is itself a
      // flag. Value-taking flags (--from NAME, --ref-id N, ...) are
      // unaffected since their values never start with "--".
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
    default:
      fail(
        `unknown command '${command}'. Expected one of: init, register, send, log, status, pending, deliver, monitor`
      );
  }
}

main();
