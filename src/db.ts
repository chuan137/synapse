import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'node:child_process';

// Project root is one level up from dist/ (where this file compiles to)
export const SYNAPSE_INSTALL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function openDb(dbPath: string): Database.Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const database = new Database(dbPath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');

  database.exec(`
    CREATE TABLE IF NOT EXISTS approval_requests (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id    TEXT    NOT NULL,
      question    TEXT    NOT NULL,
      context     TEXT,
      status      TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      comment     TEXT,
      created_at  INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id     TEXT    NOT NULL,
      to_id       TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      priority    INTEGER NOT NULL DEFAULT 5,
      created_at  INTEGER NOT NULL,
      read_at     INTEGER
    );

    CREATE TABLE IF NOT EXISTS agent_status (
      agent_id    TEXT    PRIMARY KEY,
      slot        INTEGER UNIQUE,
      name        TEXT,
      session_id  TEXT,
      tmux_pane   TEXT,
      state       TEXT    NOT NULL CHECK(state IN ('idle', 'working', 'blocked', 'error')),
      current_task TEXT,
      updated_at  INTEGER NOT NULL,
      -- Set when the agent's Claude session fires SessionEnd. A non-null value
      -- retires the row: it stays for event history but drops off the live roster.
      ended_at    INTEGER
    );

    -- Raw append-only Claude Code lifecycle event log (the audit trail + S-Deck feed).
    -- Every row is correlated to a known Synapse agent via session_id; events that
    -- cannot be correlated are dropped at ingest, so synapse_agent_id is NOT NULL.
    CREATE TABLE IF NOT EXISTS events (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id         TEXT    NOT NULL UNIQUE,   -- inspector evt_… id (idempotent ingest)
      event            TEXT    NOT NULL,          -- e.g. tool:after:Bash
      session_id       TEXT    NOT NULL,          -- Claude Code session (join key)
      synapse_agent_id TEXT    NOT NULL,          -- resolved <projectId>:<slot>
      claude_agent_id  TEXT,                      -- Claude subagent id, only on subagent:* events
      payload          TEXT,                      -- JSON blob
      timestamp        INTEGER NOT NULL,
      duration_ms      INTEGER,
      FOREIGN KEY (synapse_agent_id) REFERENCES agent_status(agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_agent ON events(synapse_agent_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, timestamp);

    -- Derived per-tool-call metrics (DESIGN.md §3.2). One row per tool:after:* event.
    CREATE TABLE IF NOT EXISTS tool_metrics (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id         TEXT    NOT NULL UNIQUE,   -- the tool:after event id
      synapse_agent_id TEXT    NOT NULL,
      session_id       TEXT    NOT NULL,
      tool             TEXT    NOT NULL,
      status           TEXT    NOT NULL CHECK(status IN ('ok', 'error')),
      duration_ms      INTEGER,
      timestamp        INTEGER NOT NULL,
      FOREIGN KEY (synapse_agent_id) REFERENCES agent_status(agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_agent ON tool_metrics(synapse_agent_id, tool);
  `);

  // Migrate existing tables — ignore errors if columns already exist
  for (const sql of [
    `ALTER TABLE agent_status ADD COLUMN name TEXT`,
    `ALTER TABLE agent_status ADD COLUMN model TEXT`,
    `ALTER TABLE agent_status ADD COLUMN effort TEXT`,
    `ALTER TABLE agent_status ADD COLUMN session_id TEXT`,
    `ALTER TABLE agent_status ADD COLUMN slot INTEGER`,
    `ALTER TABLE agent_status ADD COLUMN tmux_pane TEXT`,
    `ALTER TABLE agent_status ADD COLUMN ended_at INTEGER`,
    `ALTER TABLE agent_status ADD COLUMN role TEXT`,
  ]) {
    try { database.exec(sql); } catch { /* column already exists */ }
  }

  return database;
}

// Default instance: $SYNAPSE_DB_PATH or <cwd>/.synapse/synapse.db
const DB_PATH = process.env.SYNAPSE_DB_PATH
  ?? join(process.cwd(), '.synapse', 'synapse.db');

export const db = openDb(DB_PATH);

export interface Message {
  id: number;
  from_id: string;
  to_id: string;
  content: string;
  priority: number;
  created_at: number;
  read_at: number | null;
}

export interface AgentStatus {
  agent_id: string;
  slot: number;
  name: string | null;
  model: string | null;
  effort: string | null;
  role: string | null;
  session_id: string | null;
  tmux_pane: string | null;
  state: 'idle' | 'working' | 'blocked' | 'error';
  current_task: string | null;
  updated_at: number;
  ended_at: number | null;
}

// An EventRecord as emitted by the inspector hook (inspector/types.ts shape,
// extended with the session/agent fields the inspector's hook.mjs attaches).
export interface InspectorEvent {
  id: string;
  event: string;
  sessionId: string;
  payload?: unknown;
  timestamp: number;
  durationMs?: number;
}

export interface EventRow {
  id: number;
  event_id: string;
  event: string;
  session_id: string;
  synapse_agent_id: string;
  claude_agent_id: string | null;
  payload: string | null;
  timestamp: number;
  duration_ms: number | null;
}

export interface ToolMetricRow {
  id: number;
  event_id: string;
  synapse_agent_id: string;
  session_id: string;
  tool: string;
  status: 'ok' | 'error';
  duration_ms: number | null;
  timestamp: number;
}

// ── Queries ────────────────────────────────────────────────────────────────

const stmts = {
  getUnread: db.prepare<[string], Message>(`
    SELECT * FROM messages
    WHERE to_id = ? AND read_at IS NULL
    ORDER BY priority ASC, created_at ASC
  `),

  markRead: db.prepare<[number, string]>(`
    UPDATE messages SET read_at = ? WHERE to_id = ? AND read_at IS NULL
  `),

  insertMessage: db.prepare<[string, string, string, number, number]>(`
    INSERT INTO messages (from_id, to_id, content, priority, created_at)
    VALUES (?, ?, ?, ?, ?)
  `),

  insertAgent: db.prepare<[string, number, number], void>(`
    INSERT INTO agent_status (agent_id, slot, state, updated_at)
    VALUES (?, ?, 'idle', ?)
  `),

  upsertStatus: db.prepare<[string, string | null, string | null, string, string | null, number]>(`
    INSERT INTO agent_status (agent_id, slot, name, session_id, state, current_task, updated_at)
    VALUES (?, (SELECT COALESCE(MAX(slot) + 1, 0) FROM agent_status), ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      name         = COALESCE(excluded.name, name),
      session_id   = COALESCE(excluded.session_id, session_id),
      state        = excluded.state,
      current_task = excluded.current_task,
      updated_at   = excluded.updated_at
  `),

  // Retired agents (sessions that fired SessionEnd → ended_at set) are kept for
  // event history but hidden from the live roster.
  allStatuses: db.prepare<[], AgentStatus>(`
    SELECT * FROM agent_status WHERE ended_at IS NULL ORDER BY slot ASC
  `),

  // Live workers (slot > 0, not retired), optionally filtered by role and/or state.
  // Bound params are passed positionally; a NULL filter param disables that clause
  // via the `(? IS NULL OR col = ?)` idiom.
  liveWorkers: db.prepare<[string | null, string | null, string | null, string | null], AgentStatus>(`
    SELECT * FROM agent_status
    WHERE ended_at IS NULL
      AND slot > 0
      AND (? IS NULL OR role  = ?)
      AND (? IS NULL OR state = ?)
    ORDER BY slot ASC
  `),

  recentMessages: db.prepare<[number], Message>(`
    SELECT * FROM messages ORDER BY created_at DESC LIMIT ?
  `),

  agentHistory: db.prepare<[string, string, number], Message>(`
    SELECT * FROM (
      SELECT * FROM messages
      WHERE to_id = ? OR from_id = ?
      ORDER BY created_at DESC LIMIT ?
    ) ORDER BY created_at ASC
  `),

  // Resolve a Claude session_id to a known Synapse agent (the join key).
  agentBySession: db.prepare<[string], { agent_id: string; slot: number | null }>(`
    SELECT agent_id, slot FROM agent_status WHERE session_id = ?
  `),

  // INSERT OR IGNORE makes ingest idempotent on event_id (re-tailing is safe).
  insertEvent: db.prepare<[string, string, string, string, string | null, string | null, number, number | null]>(`
    INSERT OR IGNORE INTO events
      (event_id, event, session_id, synapse_agent_id, claude_agent_id, payload, timestamp, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),

  insertToolMetric: db.prepare<[string, string, string, string, string, number | null, number]>(`
    INSERT OR IGNORE INTO tool_metrics
      (event_id, synapse_agent_id, session_id, tool, status, duration_ms, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),

  recentEvents: db.prepare<[number], EventRow>(`
    SELECT * FROM events ORDER BY timestamp DESC LIMIT ?
  `),

  eventsByAgent: db.prepare<[string, number], EventRow>(`
    SELECT * FROM events WHERE synapse_agent_id = ? ORDER BY timestamp DESC LIMIT ?
  `),

  toolMetricsByAgent: db.prepare<[string], {
    tool: string; calls: number; errors: number; avg_ms: number | null; max_ms: number | null;
  }>(`
    SELECT tool,
           COUNT(*)                               AS calls,
           SUM(status = 'error')                  AS errors,
           AVG(duration_ms)                       AS avg_ms,
           MAX(duration_ms)                       AS max_ms
    FROM tool_metrics
    WHERE synapse_agent_id = ?
    GROUP BY tool
    ORDER BY calls DESC
  `),

  // Per-agent + per-tool rollup across the whole swarm (for the dashboard).
  toolMetricsAll: db.prepare<[], {
    synapse_agent_id: string; tool: string; calls: number; errors: number; avg_ms: number | null; max_ms: number | null;
  }>(`
    SELECT synapse_agent_id,
           tool,
           COUNT(*)              AS calls,
           SUM(status = 'error') AS errors,
           AVG(duration_ms)      AS avg_ms,
           MAX(duration_ms)      AS max_ms
    FROM tool_metrics
    GROUP BY synapse_agent_id, tool
    ORDER BY synapse_agent_id, calls DESC
  `),
};

// Claim a slot for this process. If a row with this sessionId already exists,
// reuse it (MCP restart within the same Claude session). Otherwise insert new.
export function claimAgentSlot(
  projectId: string,
  sessionId: string | null,
  tmuxPane: string | null,
  forcedSlot?: number,
): { agentId: string; slot: number } {
  return db.transaction(() => {
    // Forced slot — reuse existing row or insert at that slot
    if (forcedSlot !== undefined) {
      const agentId = `${projectId}:${forcedSlot}`;
      const existing = db.prepare<[string], { agent_id: string; slot: number }>(
        `SELECT agent_id, slot FROM agent_status WHERE agent_id = ?`
      ).get(agentId);
      if (existing) {
        db.prepare(`UPDATE agent_status SET session_id = ?, tmux_pane = ?, state = 'idle', ended_at = NULL, updated_at = ? WHERE agent_id = ?`)
          .run(sessionId, tmuxPane, Date.now(), agentId);
      } else {
        db.prepare(`INSERT INTO agent_status (agent_id, slot, session_id, tmux_pane, state, updated_at) VALUES (?, ?, ?, ?, 'idle', ?)`)
          .run(agentId, forcedSlot, sessionId, tmuxPane, Date.now());
      }
      return { agentId, slot: forcedSlot };
    }
    // Reuse by session ID
    if (sessionId) {
      const existing = db.prepare<[string], { agent_id: string; slot: number }>(
        `SELECT agent_id, slot FROM agent_status WHERE session_id = ?`
      ).get(sessionId);
      if (existing) {
        db.prepare(`UPDATE agent_status SET tmux_pane = ?, ended_at = NULL, updated_at = ? WHERE agent_id = ?`)
          .run(tmuxPane, Date.now(), existing.agent_id);
        return { agentId: existing.agent_id, slot: existing.slot };
      }
    }
    const next = (db.prepare<[], { n: number }>(
      `SELECT COALESCE(MAX(slot) + 1, 0) AS n FROM agent_status`
    ).get()!).n;
    const agentId = `${projectId}:${next}`;
    db.prepare(`INSERT INTO agent_status (agent_id, slot, session_id, tmux_pane, state, updated_at) VALUES (?, ?, ?, ?, 'idle', ?)`)
      .run(agentId, next, sessionId, tmuxPane, Date.now());
    return { agentId, slot: next };
  })();
}

export interface ApprovalRequest {
  id: number;
  agent_id: string;
  question: string;
  context: string | null;
  status: 'pending' | 'approved' | 'rejected';
  comment: string | null;
  created_at: number;
  resolved_at: number | null;
}

export function createApprovalRequest(agentId: string, question: string, context: string | null): number {
  const result = db.prepare(
    `INSERT INTO approval_requests (agent_id, question, context, created_at) VALUES (?, ?, ?, ?)`
  ).run(agentId, question, context, Date.now());
  return result.lastInsertRowid as number;
}

export function pollApproval(id: number): ApprovalRequest | null {
  return db.prepare<[number], ApprovalRequest>(
    `SELECT * FROM approval_requests WHERE id = ?`
  ).get(id) ?? null;
}

export function resolveApproval(id: number, status: 'approved' | 'rejected', comment: string | null): void {
  db.prepare(
    `UPDATE approval_requests SET status = ?, comment = ?, resolved_at = ? WHERE id = ?`
  ).run(status, comment, Date.now(), id);
}

export function getPendingApprovals(): ApprovalRequest[] {
  return db.prepare<[], ApprovalRequest>(
    `SELECT * FROM approval_requests WHERE status = 'pending' ORDER BY created_at ASC`
  ).all();
}

export function getLatestAgent(): AgentStatus | null {
  return db.prepare<[], AgentStatus>(
    `SELECT * FROM agent_status ORDER BY slot DESC LIMIT 1`
  ).get() ?? null;
}

export function getIdleAgentsWithUnreadMessages(): AgentStatus[] {
  return db.prepare<[], AgentStatus>(`
    SELECT DISTINCT a.*
    FROM agent_status a
    JOIN messages m ON m.to_id = a.agent_id AND m.read_at IS NULL
    WHERE a.state = 'idle' AND a.ended_at IS NULL
  `).all();
}

/** Idle agents with unread messages, paired with the max unread message id —
 *  lets the nudger fire once per (agent, message-set) instead of every poll. */
export function getIdleAgentsWithUnreadSignature(): { agent_id: string; tmux_pane: string | null; max_msg_id: number }[] {
  return db.prepare<[], { agent_id: string; tmux_pane: string | null; max_msg_id: number }>(`
    SELECT a.agent_id, a.tmux_pane, MAX(m.id) AS max_msg_id
    FROM agent_status a
    JOIN messages m ON m.to_id = a.agent_id AND m.read_at IS NULL
    WHERE a.state = 'idle' AND a.ended_at IS NULL
    GROUP BY a.agent_id, a.tmux_pane
  `).all();
}

export function getTmuxPane(agentId: string): string | null {
  const row = db.prepare<[string], { tmux_pane: string | null }>(
    `SELECT tmux_pane FROM agent_status WHERE agent_id = ?`
  ).get(agentId);
  return row?.tmux_pane ?? null;
}

export function readMessages(agentId: string): Message[] {
  const msgs = stmts.getUnread.all(agentId);
  if (msgs.length > 0) stmts.markRead.run(Date.now(), agentId);
  return msgs;
}

export function sendMessage(
  fromId: string,
  toId: string,
  content: string,
  priority: number = 5
): void {
  stmts.insertMessage.run(fromId, toId, content, priority, Date.now());
}

export function updateStatus(
  agentId: string,
  state: AgentStatus['state'],
  currentTask: string | null = null,
  name: string | null = null,
  sessionId: string | null = null,
): void {
  stmts.upsertStatus.run(agentId, name, sessionId, state, currentTask, Date.now());
}

export function updateAgentConfig(
  agentId: string,
  fields: { name?: string | null; model?: string | null; effort?: string | null },
): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { agentId };
  if ('name'   in fields) { sets.push('name = :name');     params.name   = fields.name   ?? null; }
  if ('model'  in fields) { sets.push('model = :model');   params.model  = fields.model  ?? null; }
  if ('effort' in fields) { sets.push('effort = :effort'); params.effort = fields.effort ?? null; }
  if (sets.length === 0) return;
  db.prepare(`UPDATE agent_status SET ${sets.join(', ')} WHERE agent_id = :agentId`).run(params);
}

export function getAllStatuses(): AgentStatus[] {
  return stmts.allStatuses.all();
}

export interface LiveWorker {
  agent_id: string;
  slot: number;
  role: string | null;
  name: string | null;
  state: AgentStatus['state'];
  current_task: string | null;
  last_seen_ms_ago: number;
}

/**
 * Live worker agents in the pool — the source of truth for routing decisions.
 * "Live" = not retired (ended_at IS NULL). The session-end hook stamps
 * ended_at on SessionEnd; claimAgentSlot clears it on a session restart, so a
 * legitimately restarted agent reappears. Slot 0 (the orchestrator) is
 * excluded; this is for finding workers, not self. Optionally filtered by
 * role and/or state.
 *
 * `last_seen_ms_ago` is informational only — a long quiet period for an idle
 * worker is normal, not a signal that the worker is gone.
 */
export function listLiveWorkers(
  filters: { role?: string; state?: AgentStatus['state'] } = {},
): LiveWorker[] {
  const now = Date.now();
  const role = filters.role ?? null;
  const state = filters.state ?? null;
  return stmts.liveWorkers
    .all(role, role, state, state)
    .map((r) => ({
      agent_id: r.agent_id,
      slot: r.slot,
      role: r.role,
      name: r.name,
      state: r.state,
      current_task: r.current_task,
      last_seen_ms_ago: now - r.updated_at,
    }));
}

/** Write an agent's role into its agent_status row (set by spawn_agent once the
 *  worker has registered). No-op for an unknown agent_id. */
export function setAgentRole(agentId: string, role: string): void {
  db.prepare(`UPDATE agent_status SET role = ? WHERE agent_id = ?`).run(role, agentId);
}

export function getAgentConfigBySlot(
  projectId: string,
  slot: number,
): { model: string | null; effort: string | null; name: string | null } | null {
  const agentId = `${projectId}:${slot}`;
  const row = db.prepare<[string], { model: string | null; effort: string | null; name: string | null }>(
    `SELECT model, effort, name FROM agent_status WHERE agent_id = ?`
  ).get(agentId);
  return row ?? null;
}

export function getRecentMessages(limit = 100): Message[] {
  return stmts.recentMessages.all(limit);
}

export function getAgentHistory(agentId: string, limit = 10): Message[] {
  return stmts.agentHistory.all(agentId, agentId, limit);
}

/** Resolve a Claude session_id to its Synapse agent (id + slot), or null if unknown. */
export function resolveSessionToAgent(
  sessionId: string,
): { agentId: string; slot: number | null } | null {
  const row = stmts.agentBySession.get(sessionId);
  return row ? { agentId: row.agent_id, slot: row.slot } : null;
}

// ── Event ingestion ──────────────────────────────────────────────────────────

/**
 * Ingest one inspector EventRecord into the events log, correlating it to a
 * Synapse agent via session_id. Events whose session_id does not map to a known
 * agent are DROPPED (returns null) — the table is swarm-only by design. A
 * tool:after:* event additionally produces a derived tool_metrics row.
 *
 * Idempotent: re-ingesting the same event_id is a no-op (INSERT OR IGNORE).
 * Returns the resolved synapse agent_id when stored, or null when dropped.
 */
export function ingestEvent(ev: InspectorEvent): string | null {
  if (!ev?.id || !ev.event || !ev.sessionId) return null;

  const agent = stmts.agentBySession.get(ev.sessionId);
  if (!agent) return null; // unmatched → drop

  const payload = (ev.payload && typeof ev.payload === 'object')
    ? (ev.payload as Record<string, unknown>)
    : {};
  // Claude's internal subagent id, present only on subagent:* events.
  const claudeAgentId = typeof payload.agentId === 'string' ? payload.agentId : null;
  const durationMs = typeof ev.durationMs === 'number' ? ev.durationMs : null;

  return db.transaction(() => {
    stmts.insertEvent.run(
      ev.id,
      ev.event,
      ev.sessionId,
      agent.agent_id,
      claudeAgentId,
      Object.keys(payload).length ? JSON.stringify(payload) : null,
      ev.timestamp,
      durationMs,
    );

    // Derive a tool_metrics row from tool:after:<Tool> events.
    if (ev.event.startsWith('tool:after:')) {
      const tool = typeof payload.tool === 'string'
        ? payload.tool
        : ev.event.slice('tool:after:'.length);
      const status = payload.status === 'error' ? 'error' : 'ok';
      stmts.insertToolMetric.run(
        ev.id, agent.agent_id, ev.sessionId, tool, status, durationMs, ev.timestamp,
      );
    }

    return agent.agent_id;
  })();
}

/**
 * Event-driven liveness: set an agent's state from observed activity.
 * Only flips between 'idle' and 'working' — never overwrites a self-reported
 * 'blocked' or 'error' (those are intentional states only the agent knows).
 * No-op if the session maps to no known agent.
 */
export function setLivenessBySession(sessionId: string, state: 'idle' | 'working'): void {
  db.prepare(`
    UPDATE agent_status
       SET state = ?, updated_at = ?
     WHERE session_id = ?
       AND state IN ('idle', 'working')
  `).run(state, Date.now(), sessionId);
}

/**
 * Retire an agent when its Claude session fires SessionEnd. The row is kept
 * (events/tool_metrics FK-reference it and we want the history) but stamped with
 * ended_at, which hides it from the live roster (getAllStatuses) and the
 * idle-nudge pollers. No-op for an unknown session. A later claimAgentSlot reuse
 * of the same session clears ended_at, so a genuinely restarted session reappears.
 */
export function markAgentEndedBySession(sessionId: string): void {
  const now = Date.now();
  db.prepare(`
    UPDATE agent_status
       SET ended_at = ?, updated_at = ?
     WHERE session_id = ? AND ended_at IS NULL
  `).run(now, now, sessionId);
}

/**
 * Detect "ghost" agents — rows where ended_at IS NULL (so the system
 * still thinks they're alive) but their tmux pane no longer exists.
 * This happens when a Claude process is killed without a graceful
 * SessionEnd: the post-stop hook never fires, ended_at never gets
 * stamped, and the row would live forever.
 *
 * Strategy: list all live tmux pane ids in one shell call, build a Set,
 * then mark every live agent row whose tmux_pane is NOT in the Set as
 * ended (stamping ended_at = now). After this runs, purgeStaleAgents()
 * will sweep the now-retired ghosts on the same pass.
 *
 * Returns the count of ghosts marked. Slot 0 (the orchestrator itself)
 * is excluded — if the orchestrator's pane disappears, the orchestrator
 * is dead and isn't running this code anyway.
 *
 * Tmux is shelled out via `tmux list-panes -aF '#{pane_id}'`. If tmux
 * is unavailable (no session, binary missing) the call returns 0
 * without touching the DB — fail-closed.
 */
export function reapGhostAgents(): number {
  let livePaneIds: Set<string>;
  try {
    const out = execFileSync('tmux', ['list-panes', '-aF', '#{pane_id}'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    livePaneIds = new Set(out.split('\n').map(s => s.trim()).filter(Boolean));
  } catch {
    return 0; // tmux not running, no panes — don't touch anything
  }

  const now = Date.now();
  const candidates = db.prepare<[], { agent_id: string; tmux_pane: string | null }>(`
    SELECT agent_id, tmux_pane FROM agent_status
    WHERE ended_at IS NULL AND slot > 0 AND tmux_pane IS NOT NULL
  `).all();

  const ghosts = candidates.filter(c => c.tmux_pane && !livePaneIds.has(c.tmux_pane));
  if (ghosts.length === 0) return 0;

  const stmt = db.prepare(`UPDATE agent_status SET ended_at = ?, updated_at = ? WHERE agent_id = ?`);
  const tx = db.transaction(() => {
    for (const g of ghosts) stmt.run(now, now, g.agent_id);
  });
  tx();
  return ghosts.length;
}

/**
 * Hard-delete RETIRED agent rows that have no tool_metrics or message
 * history worth preserving. "Retired" = ended_at IS NOT NULL — set by
 * markAgentEndedBySession on SessionEnd, or by reapGhostAgents below
 * when an agent's tmux pane has vanished without a graceful end.
 *
 * Live (ended_at IS NULL) rows are NEVER touched by this function,
 * regardless of how quiet they have been. A long-idle worker is fine.
 *
 * Returns the count of agents removed. Only session:start/session:end
 * events are deleted with them.
 */
export function purgeStaleAgents(): number {
  return db.transaction(() => {
    const candidates = db.prepare<[], { agent_id: string }>(`
      SELECT agent_id FROM agent_status
      WHERE ended_at IS NOT NULL
        AND agent_id NOT IN (SELECT synapse_agent_id FROM tool_metrics)
        AND agent_id NOT IN (
          SELECT from_id FROM messages
          UNION
          SELECT to_id FROM messages WHERE to_id != 'human'
        )
    `).all();

    if (candidates.length === 0) return 0;
    const ids = candidates.map(r => r.agent_id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM events WHERE synapse_agent_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM agent_status WHERE agent_id IN (${placeholders})`).run(...ids);
    return ids.length;
  })();
}

/**
 * Post a deck milestone *as* the agent that owns this session, deduplicated on the
 * exact content so the same observable event (e.g. one git commit, keyed by its
 * hash in the text) is announced at most once. Used by the event hook for
 * deterministic milestones (COMMIT) that don't depend on the model remembering to
 * call send_message. No-op if the session maps to no known agent or an identical
 * message from this agent already exists.
 */
export function postMilestoneOnce(sessionId: string, content: string, priority = 5): void {
  const agent = stmts.agentBySession.get(sessionId);
  if (!agent) return;
  const dup = db.prepare(
    `SELECT 1 FROM messages WHERE from_id = ? AND to_id = 'human' AND content = ? LIMIT 1`
  ).get(agent.agent_id, content);
  if (dup) return;
  stmts.insertMessage.run(agent.agent_id, 'human', content, priority, Date.now());
}

export function getRecentEvents(limit = 200): EventRow[] {
  return stmts.recentEvents.all(limit);
}

export function getEventsByAgent(agentId: string, limit = 200): EventRow[] {
  return stmts.eventsByAgent.all(agentId, limit);
}

export interface ToolMetricSummary {
  tool: string;
  calls: number;
  errors: number;
  avg_ms: number | null;
  max_ms: number | null;
}

export function getToolMetricsByAgent(agentId: string): ToolMetricSummary[] {
  return stmts.toolMetricsByAgent.all(agentId);
}

export interface AgentToolMetric extends ToolMetricSummary {
  synapse_agent_id: string;
}

/** Whole-swarm tool metrics, one row per (agent, tool). */
export function getAllToolMetrics(): AgentToolMetric[] {
  return stmts.toolMetricsAll.all();
}
