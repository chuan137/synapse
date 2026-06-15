import { openDb } from '../db.js';
import { mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { AgentTrajectory, BlockedEvent, ToolStats } from './schema-v2.js';

// ── C3 interfaces ─────────────────────────────────────────────────────────────

export interface ToolByTool {
  count: number;
  ok: number;
  err: number;
  avg_ms: number;
  max_ms: number;
  p95_ms: number;
}

export interface AntiPatterns {
  repeat_reads:      Record<string, number>;  // path → count (count > 1 within task)
  read_no_edit:      string[];                // paths read but never written/edited
  bash_repeats:      Record<string, number>;  // cmd prefix → count (count > 1)
  edit_retries:      Record<string, number>;  // path → count (Edit/Write ≥ 2×)
  read_per_turn_max: number;                  // max Reads in any single turn-window
}

export interface ToolMetricsSummary {
  total_calls:       number;
  by_tool:           Record<string, ToolByTool>;
  duration_total_ms: number;
  error_rate:        number;
  anti_patterns:     AntiPatterns;
}

export interface MessageSnippet {
  from: string;
  to:   string;
  content_200: string;
}

// C3 case interface (schema_version: 3)
export interface TrajectoryCase {
  schema_version: 3;
  id: number;
  label: 'good' | 'bad';
  task: Record<string, unknown>;
  message_snippets: MessageSnippet[];
  metrics: {
    tool_calls: number;
    duration_ms: number | null;
    traceability_score: number;
    has_commit: boolean;
  };
  title: string;
  started_at: number;
  finished_at: number | null;
  total_duration_ms: number | null;
  agents: Record<string, AgentTrajectory>;
  blocked_events: BlockedEvent[];
  tool_metrics: { summary: ToolMetricsSummary; ids: number[] };
}

const BLOCKED_PATTERNS: { pattern: RegExp | string; category: BlockedEvent['category'] }[] = [
  { pattern: /CONFUSED/i,  category: 'CONFUSED' },
  { pattern: /不确定/,      category: 'CONFUSED' },
  { pattern: /unsure/i,    category: 'CONFUSED' },
  { pattern: /WAITING/i,   category: 'WAITING'  },
  { pattern: /ERROR/i,     category: 'ERROR'    },
];

function categorizeBlockedText(text: string): BlockedEvent['category'] {
  for (const { pattern, category } of BLOCKED_PATTERNS) {
    if (pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern as string)) {
      return category;
    }
  }
  return 'OTHER';
}

function slotFromAgentId(agentId: string): number | null {
  const m = agentId.match(/:(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(p * sorted.length)];
}

function aggregateByAgent(
  toolMetrics: any[],
  agentRoleMap: Map<string, string>,
  messages: any[],
): Record<string, AgentTrajectory> {
  const agentData: Map<string, {
    durations: number[];
    toolDurations: Map<string, number[]>;
    toolErrors: Map<string, number>;
  }> = new Map();

  for (const m of toolMetrics) {
    const agentId: string = m.synapse_agent_id;
    if (!agentData.has(agentId)) {
      agentData.set(agentId, { durations: [], toolDurations: new Map(), toolErrors: new Map() });
    }
    const data = agentData.get(agentId)!;
    if (m.duration_ms != null) data.durations.push(m.duration_ms);
    const tool: string = m.tool;
    if (!data.toolDurations.has(tool)) data.toolDurations.set(tool, []);
    if (m.duration_ms != null) data.toolDurations.get(tool)!.push(m.duration_ms);
    if (m.status === 'error') {
      data.toolErrors.set(tool, (data.toolErrors.get(tool) ?? 0) + 1);
    }
  }

  const messagesIn: Map<string, number>  = new Map();
  const messagesOut: Map<string, number> = new Map();
  for (const msg of messages) {
    const from: string = msg.from_id;
    const to: string   = msg.to_id;
    if (from !== 'human') messagesOut.set(from, (messagesOut.get(from) ?? 0) + 1);
    if (to   !== 'human') messagesIn.set(to,   (messagesIn.get(to)    ?? 0) + 1);
  }

  const blockedByAgent: Map<string, BlockedEvent[]> = new Map();
  for (const msg of messages) {
    const content: string = typeof msg.content === 'string' ? msg.content : '';
    const isBlocked = msg.type === 'blocked' || content.trimStart().toUpperCase().startsWith('BLOCKED');
    if (!isBlocked) continue;
    const agentId: string = msg.from_id;
    if (!blockedByAgent.has(agentId)) blockedByAgent.set(agentId, []);
    blockedByAgent.get(agentId)!.push({
      agent_id: agentId,
      text: content.slice(0, 200),
      at: msg.created_at as number ?? 0,
      category: categorizeBlockedText(content),
    });
  }

  const result: Record<string, AgentTrajectory> = {};
  const allAgentIds = new Set([
    ...agentData.keys(),
    ...Array.from(messagesIn.keys()),
    ...Array.from(messagesOut.keys()),
  ]);

  for (const agentId of allAgentIds) {
    if (agentId === 'human') continue;
    const role = agentRoleMap.get(agentId) ?? 'unknown';
    const slot = slotFromAgentId(agentId);
    const key = `${role}:${slot ?? agentId}`;
    const data = agentData.get(agentId);
    const tools: Record<string, ToolStats> = {};
    if (data) {
      for (const [tool, durations] of data.toolDurations.entries()) {
        const calls = durations.length;
        const errors = data.toolErrors.get(tool) ?? 0;
        const avg = calls > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / calls) : 0;
        tools[tool] = {
          calls,
          avg_ms: avg,
          p90_ms: percentile(durations, 0.9),
          errors,
          error_rate: calls > 0 ? errors / calls : 0,
        };
      }
    }
    result[key] = {
      agent_id: agentId,
      role,
      tools,
      blocked_events: blockedByAgent.get(agentId) ?? [],
      messages_in:  messagesIn.get(agentId)  ?? 0,
      messages_out: messagesOut.get(agentId) ?? 0,
      active_duration_ms: data?.durations.reduce((a, b) => a + b, 0) ?? 0,
    };
  }

  return result;
}

// ── Tool metrics summary + anti-pattern computation ────────────────────────────

function extractFingerprint(tool: string, inputJson: string | null): string | null {
  if (!inputJson) return null;
  try {
    const input = JSON.parse(inputJson);
    if (tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
      return typeof input.file_path === 'string' ? input.file_path : null;
    }
    if (tool === 'Bash') {
      return typeof input.command === 'string' ? input.command.slice(0, 60) : null;
    }
    if (tool === 'Glob' || tool === 'Grep') {
      return typeof input.pattern === 'string' ? input.pattern : null;
    }
  } catch {}
  return null;
}

// TURN_GAP_MS: consecutive tool calls more than 30s apart → different "turn"
const TURN_GAP_MS = 30_000;

function buildToolMetricsSummary(toolMetricsWithInput: any[]): { summary: ToolMetricsSummary; ids: number[] } {
  const ids: number[]                          = [];
  const byTool: Record<string, { counts: number[]; oks: number; errs: number }> = {};
  let durationTotal = 0;
  let errTotal = 0;

  // Track fingerprints for anti-patterns
  const readPaths: string[]   = [];
  const editPaths: string[]   = [];
  const bashPrefixes: string[] = [];

  // Per-turn Read tracking: sort by timestamp, bucket by TURN_GAP_MS
  const sortedWithInput = [...toolMetricsWithInput].sort((a, b) => a.timestamp - b.timestamp);

  for (const row of sortedWithInput) {
    ids.push(row.id);
    const tool: string   = row.tool;
    const durMs: number  = row.duration_ms ?? 0;
    const ok             = row.status !== 'error';

    if (!byTool[tool]) byTool[tool] = { counts: [], oks: 0, errs: 0 };
    byTool[tool].counts.push(durMs);
    if (ok) byTool[tool].oks++; else byTool[tool].errs++;

    durationTotal += durMs;
    if (!ok) errTotal++;

    const fp = extractFingerprint(tool, row.input_json ?? null);
    if (fp) {
      if (tool === 'Read') readPaths.push(fp);
      else if (tool === 'Edit' || tool === 'Write') editPaths.push(fp);
      else if (tool === 'Bash') bashPrefixes.push(fp);
    }
  }

  // by_tool aggregation
  const by_tool: Record<string, ToolByTool> = {};
  for (const [tool, data] of Object.entries(byTool)) {
    const counts = data.counts;
    const total = counts.length;
    const sum = counts.reduce((a, b) => a + b, 0);
    by_tool[tool] = {
      count: total,
      ok:    data.oks,
      err:   data.errs,
      avg_ms: total > 0 ? Math.round(sum / total) : 0,
      max_ms: total > 0 ? Math.max(...counts) : 0,
      p95_ms: percentile(counts, 0.95),
    };
  }

  // Anti-patterns
  const totalCalls = sortedWithInput.length;

  // repeat_reads: file read ≥ 2× in this task
  const readCounts: Record<string, number> = {};
  for (const p of readPaths) readCounts[p] = (readCounts[p] ?? 0) + 1;
  const repeat_reads: Record<string, number> = Object.fromEntries(
    Object.entries(readCounts).filter(([, c]) => c > 1)
  );

  // read_no_edit: read but never edited/written
  const editSet = new Set(editPaths);
  const read_no_edit = [...new Set(readPaths)].filter(p => !editSet.has(p));

  // bash_repeats: same prefix ≥ 2×
  const bashCounts: Record<string, number> = {};
  for (const p of bashPrefixes) bashCounts[p] = (bashCounts[p] ?? 0) + 1;
  const bash_repeats: Record<string, number> = Object.fromEntries(
    Object.entries(bashCounts).filter(([, c]) => c > 1)
  );

  // edit_retries: Edit/Write retried after a prior error on the same path.
  // A clean multi-step refactor (Edit → Edit, both ok) is NOT a retry.
  // Rule: count an Edit as a retry only if the previous Edit on the same path had status='error'.
  const editLastStatus: Record<string, string> = {};
  const editRetryRaw: Record<string, number> = {};
  for (const row of sortedWithInput) {
    if (row.tool !== 'Edit' && row.tool !== 'Write') continue;
    const fp = extractFingerprint(row.tool, row.input_json ?? null);
    if (!fp) continue;
    if (editLastStatus[fp] === 'error') {
      editRetryRaw[fp] = (editRetryRaw[fp] ?? 0) + 1;
    }
    editLastStatus[fp] = row.status;
  }
  const edit_retries: Record<string, number> = editRetryRaw;

  // read_per_turn_max: max Reads within a single turn-window
  let read_per_turn_max = 0;
  let turnReadCount = 0;
  let prevTimestamp = 0;
  for (const row of sortedWithInput) {
    if (row.tool !== 'Read') continue;
    const ts: number = row.timestamp ?? 0;
    if (prevTimestamp > 0 && ts - prevTimestamp > TURN_GAP_MS) {
      read_per_turn_max = Math.max(read_per_turn_max, turnReadCount);
      turnReadCount = 0;
    }
    turnReadCount++;
    prevTimestamp = ts;
  }
  read_per_turn_max = Math.max(read_per_turn_max, turnReadCount);

  return {
    ids,
    summary: {
      total_calls: totalCalls,
      by_tool,
      duration_total_ms: durationTotal,
      error_rate: totalCalls > 0 ? errTotal / totalCalls : 0,
      anti_patterns: { repeat_reads, read_no_edit, bash_repeats, edit_retries, read_per_turn_max },
    },
  };
}

// ── Public API ─────────────────────────────────────────────────────────────────

export function extractCases(dbPath: string, outDir: string, limit = 20, taskId?: number): TrajectoryCase[] {
  const db = openDb(dbPath);

  const tasks = taskId !== undefined
    ? (db.prepare(`SELECT * FROM tasks WHERE id = ? AND finished_at IS NOT NULL`).all(taskId) as any[])
    : (db.prepare(`SELECT * FROM tasks WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT ?`).all(limit) as any[]);

  const cases = tasks.map(task => buildCase(db, task));

  db.close();
  mkdirSync(outDir, { recursive: true });
  cases.forEach(c => {
    writeFileSync(join(outDir, `task_${c.id}_${c.label}.json`), JSON.stringify(c, null, 2));
  });
  return cases;
}

export function regenerateAllCases(dbPath: string, casesDir: string): number {
  const db = openDb(dbPath);
  const files = readdirSync(casesDir).filter(f => f.match(/^task_\d+_(?:good|bad)\.json$/));
  const taskIds = files.map(f => parseInt(f.match(/^task_(\d+)_/)![1], 10));
  let count = 0;
  for (const taskId of taskIds) {
    const row = db.prepare(`SELECT * FROM tasks WHERE id = ? AND finished_at IS NOT NULL`).get(taskId) as any;
    if (!row) continue;
    const c = buildCase(db, row);
    writeFileSync(join(casesDir, `task_${c.id}_${c.label}.json`), JSON.stringify(c, null, 2));
    count++;
  }
  db.close();
  return count;
}

function buildCase(db: any, task: any): TrajectoryCase {
  // Fetch messages for agent-role mapping and blocked-event detection only (no content in output)
  const messages: any[] = db.prepare(`
    SELECT id, from_id, to_id, content, type, created_at FROM messages
    WHERE created_at >= ?
      AND created_at <= COALESCE(?, 9999999999999)
      AND (from_id = ? OR to_id = ?)
    ORDER BY created_at
  `).all(task.started_at, task.finished_at, task.agent_id, task.agent_id) as any[];

  // FK attribution, time-window fallback
  let toolMetricsBase: any[] = db.prepare(`
    SELECT tm.*, e.payload AS _event_payload
    FROM tool_metrics tm
    LEFT JOIN events e ON e.event_id = tm.event_id
    WHERE tm.task_id = ?
    ORDER BY tm.timestamp
  `).all(task.id) as any[];

  if (toolMetricsBase.length === 0) {
    toolMetricsBase = db.prepare(`
      SELECT tm.*, e.payload AS _event_payload
      FROM tool_metrics tm
      LEFT JOIN events e ON e.event_id = tm.event_id
      WHERE tm.synapse_agent_id = ?
        AND tm.timestamp >= ?
        AND tm.timestamp <= COALESCE(?, 9999999999999)
      ORDER BY tm.timestamp
    `).all(task.agent_id, task.started_at, task.finished_at) as any[];
  }

  // Parse input_json from event payload for each tool metric row
  const toolMetricsWithInput = toolMetricsBase.map((row: any) => {
    let input_json: string | null = null;
    if (row._event_payload) {
      try {
        const p = JSON.parse(row._event_payload);
        if (typeof p.input === 'string') input_json = p.input;
      } catch {}
    }
    return { ...row, input_json };
  });

  const missingLinks =
    (task.source_msg_id  ? 0 : 1) +
    (task.trigger_msg_id ? 0 : 1) +
    (task.result_msg_id  ? 0 : 1);

  // Agent role map
  const agentIds = new Set<string>([task.agent_id]);
  for (const m of toolMetricsBase) agentIds.add(m.synapse_agent_id);
  for (const msg of messages) {
    if (msg.from_id !== 'human') agentIds.add(msg.from_id as string);
    if (msg.to_id   !== 'human') agentIds.add(msg.to_id   as string);
  }

  const agentRoleMap = new Map<string, string>();
  for (const agentId of agentIds) {
    if (agentId === 'human') continue;
    const slot = slotFromAgentId(agentId);
    if (slot === 0) {
      agentRoleMap.set(agentId, 'orchestrator');
    } else {
      const row = db.prepare(`SELECT role FROM agent_status WHERE agent_id = ?`).get(agentId) as any;
      agentRoleMap.set(agentId, row?.role ?? 'unknown');
    }
  }

  const agents = aggregateByAgent(toolMetricsBase, agentRoleMap, messages);

  const blockedEvents: BlockedEvent[] = (messages as any[])
    .filter(m => {
      const content: string = typeof m.content === 'string' ? m.content : '';
      return m.type === 'blocked' || content.trimStart().toUpperCase().startsWith('BLOCKED');
    })
    .map(m => ({
      agent_id: m.from_id as string,
      text: (m.content as string).slice(0, 200),
      at: m.created_at as number ?? 0,
      category: categorizeBlockedText(m.content as string),
    }));

  // Message snippets: last 5 messages (most recent), content truncated to 200 chars.
  // Critic needs the DONE report and final exchange, not the task assignment header.
  const message_snippets: MessageSnippet[] = messages.slice(-5).map(m => ({
    from: String(m.from_id ?? ''),
    to:   String(m.to_id ?? ''),
    content_200: String(m.content ?? '').slice(0, 200),
  }));

  const toolMetricsSummary = buildToolMetricsSummary(toolMetricsWithInput);
  const totalDurationMs = (task.started_at && task.finished_at) ? task.finished_at - task.started_at : null;

  return {
    schema_version: 3,
    id: task.id,
    label: 'good',
    task,
    message_snippets,
    metrics: {
      tool_calls: toolMetricsBase.length,
      duration_ms: totalDurationMs,
      traceability_score: missingLinks,
      has_commit: !!task.commit_sha,
    },
    title: task.title ?? '',
    started_at: task.started_at,
    finished_at: task.finished_at ?? null,
    total_duration_ms: totalDurationMs,
    agents,
    blocked_events: blockedEvents,
    tool_metrics: toolMetricsSummary,
  };
}
