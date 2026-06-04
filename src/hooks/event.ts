/**
 * Synapse Event Hook — `synapse hook event <HookType>`
 *
 * Invoked by Claude Code at each lifecycle hook point. Normalizes the event into
 * the inspector EventRecord shape and ingests it into synapse.db, correlated to a
 * Synapse agent by session_id (events from unknown sessions are dropped at ingest).
 * Also drives the event-driven liveness heartbeat (idle/working).
 *
 * Runs as a CLI subcommand so it shares the installed db.js directly — no path
 * resolution, no copied files. Reads the Claude Code hook payload from stdin.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { ingestEvent, setLivenessBySession, markAgentEndedBySession, postMilestoneOnce } from '../db.js';

const MAX_LEN = 500;

// Timing files (for tool-call durations) live next to the active DB so they're
// per-project runtime state. Mirror db.ts's path logic.
const SYNAPSE_DIR = process.env.SYNAPSE_DB_PATH
  ? join(process.env.SYNAPSE_DB_PATH, '..')
  : join(process.cwd(), '.synapse');
const TIMING_DIR = join(SYNAPSE_DIR, 'timing');

export async function runEventHook(hookType: string | undefined): Promise<void> {
  if (!hookType) {
    process.stderr.write('Usage: synapse hook event <HookType>\n');
    process.exit(1);
  }
  mkdirSync(TIMING_DIR, { recursive: true });

  const raw = await readStdin();
  let payload: any;
  try { payload = JSON.parse(raw); } catch { payload = { raw }; }

  const record = buildRecord(hookType, payload);
  if (record) {
    try { ingestEvent(record); } catch { /* never block the agent on telemetry */ }
  }

  // Event-driven liveness: the hook owns idle/working; it never overwrites a
  // self-reported blocked/error (see setLivenessBySession). SessionEnd is
  // terminal — it retires the agent (markAgentEndedBySession) so a dead session
  // stops showing on the live roster, rather than lingering as a phantom 'idle'.
  const sessionId: string | undefined = payload.session_id;
  if (sessionId) {
    if (hookType === 'SessionEnd') {
      try { markAgentEndedBySession(sessionId); } catch { /* telemetry must not block */ }
    } else {
      const live =
        (hookType === 'PreToolUse' || hookType === 'UserPromptSubmit' || hookType === 'SubagentStart') ? 'working'
        : (hookType === 'Stop') ? 'idle'
        : null;
      if (live) {
        try { setLivenessBySession(sessionId, live as 'idle' | 'working'); } catch { /* telemetry must not block */ }
      }
    }
  }

  // Deterministic deck milestones: some events are worth announcing on S-Deck
  // regardless of whether the model remembers to send_message. We detect them
  // from the observable hook payload and post as the agent (deduped by content).
  if (sessionId) {
    try { emitDeterministicMilestones(hookType, sessionId, payload); } catch { /* never block on telemetry */ }
  }

  // Hooks must exit 0 and stay silent on stdout so we don't perturb the agent.
  process.exit(0);
}

/** Extract human-readable text from a tool response (string or structured object). */
function toolResponseText(resp: unknown): string {
  if (typeof resp === 'string') return resp;
  if (!resp || typeof resp !== 'object') return String(resp ?? '');
  const r = resp as Record<string, unknown>;
  // Claude tool_result shape: { type: 'tool_result', content: [{type:'text', text:'...'}] }
  if (Array.isArray(r.content)) {
    return (r.content as any[])
      .filter((c) => c?.type === 'text')
      .map((c) => String(c.text ?? ''))
      .join('\n');
  }
  // stdout/stderr shape
  if (typeof r.stdout === 'string') return r.stdout;
  // fallback: join any string-valued fields
  return Object.values(r).filter((v) => typeof v === 'string').join('\n');
}

/**
 * Emit deck milestones we can observe directly from a hook payload — currently a
 * successful `git commit` seen in a PostToolUse Bash call. The commit hash makes
 * the message self-deduping, so re-runs/retries never double-post.
 */
function emitDeterministicMilestones(hookType: string, sessionId: string, payload: any): void {
  if (hookType !== 'PostToolUse') return;
  if ((payload.tool_name ?? '') !== 'Bash') return;

  const cmd = String(payload.tool_input?.command ?? '');
  // Only care about commands that actually create a commit (not status/log/diff).
  if (!/\bgit\b[^|&;]*\bcommit\b/.test(cmd)) return;

  const out = toolResponseText(payload.tool_response);
  if (isError(payload.tool_response)) return; // failed commit → nothing to announce

  // Pull the short hash + subject git prints, e.g. "[main f29cb5f] Subject line".
  const m = out.match(/\[[^\]]*\b([0-9a-f]{7,40})\]\s*(.+)/);
  if (!m) return;
  const [, hash, subject] = m;
  // Take only the first line of the subject (git may print stats on subsequent lines).
  const firstLine = subject.split(/\\n|\n/)[0].trim();
  postMilestoneOnce(sessionId, `✅ committed ${hash}: ${firstLine}`.slice(0, MAX_LEN));
}

function buildRecord(type: string, payload: any) {
  const now  = Date.now();
  const rand = Math.random().toString(36).slice(2, 7);
  const sessionId = payload.session_id ?? 'unknown';
  const base = (event: string, extra: Record<string, unknown> = {}) => ({
    id: `evt_${now}_${rand}`,
    event,
    sessionId,
    timestamp: now,
    ...extra,
  });

  switch (type) {
    case 'PreToolUse': {
      const tool = payload.tool_name ?? 'unknown';
      // Stash start time keyed by session+tool so PostToolUse can compute duration.
      try { writeFileSync(join(TIMING_DIR, `${sessionId}__${tool}__${now}.t`), String(now)); } catch {}
      return base(`tool:before:${tool}`, { payload: { tool, input: truncate(payload.tool_input) } });
    }
    case 'PostToolUse': {
      const tool   = payload.tool_name ?? 'unknown';
      const status = isError(payload.tool_response) ? 'error' : 'ok';
      const durationMs = popTiming(sessionId, tool, now);
      return base(`tool:after:${tool}`, {
        payload: { tool, input: truncate(payload.tool_input), output: truncate(payload.tool_response), status },
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
    }
    case 'SubagentStart': {
      const agentType = payload.agent_type ?? 'unknown';
      return base(`subagent:start:${agentType}`, { payload: { agentType, agentId: payload.agent_id ?? 'unknown' } });
    }
    case 'SubagentStop': {
      const agentType = payload.agent_type ?? 'unknown';
      return base(`subagent:stop:${agentType}`, { payload: { agentType, agentId: payload.agent_id ?? 'unknown' } });
    }
    case 'UserPromptSubmit':
      return base('user:prompt', { payload: { prompt: truncate(payload.prompt ?? payload.user_prompt ?? payload) } });
    case 'PreCompact':
      return base('context:compact', { payload: { trigger: payload.trigger ?? 'unknown' } });
    case 'SessionStart':
      return base('session:start', { payload: { source: payload.source ?? 'unknown' } });
    case 'SessionEnd':
      // GC any timing files this session leaked (a tool whose PostToolUse never fired).
      return base('session:end', { payload: { reason: payload.reason ?? 'unknown', sweptTimingFiles: sweepSessionTiming(sessionId) } });
    case 'Stop':
      return base('agent:stop', { payload: { stopReason: payload.stop_reason ?? 'unknown' } });
    case 'Notification':
      return base('agent:notification', { payload: { message: truncate(payload.message ?? payload) } });
    default:
      return null;
  }
}

/** Read+delete the most recent start-time file for this session+tool; return elapsed ms. */
function popTiming(sessionId: string, tool: string, now: number): number | undefined {
  const prefix = `${sessionId}__${tool}__`;
  try {
    const files = readdirSync(TIMING_DIR).filter((f) => f.startsWith(prefix)).sort();
    if (!files.length) return undefined;
    const file = join(TIMING_DIR, files[files.length - 1]); // most recent
    const start = Number(readFileSync(file, 'utf8'));
    try { unlinkSync(file); } catch {}
    return Number.isFinite(start) ? now - start : undefined;
  } catch { return undefined; }
}

/** Delete leftover timing files for a session. Returns count removed. */
function sweepSessionTiming(sessionId: string): number {
  let removed = 0;
  try {
    for (const f of readdirSync(TIMING_DIR).filter((f) => f.startsWith(`${sessionId}__`))) {
      try { unlinkSync(join(TIMING_DIR, f)); removed++; } catch {}
    }
  } catch {}
  return removed;
}

function truncate(value: unknown): string | null {
  if (value == null) return null;
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s.length > MAX_LEN ? s.slice(0, MAX_LEN) + '…' : s;
}

function isError(response: unknown): boolean {
  if (!response) return false;
  const s = typeof response === 'string' ? response : JSON.stringify(response);
  return s.includes('"is_error":true') || s.includes('"type":"error"');
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => resolve(raw));
  });
}
