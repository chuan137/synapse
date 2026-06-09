import { openDb } from '../db.js';
import { mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { AgentTrajectory, BlockedEvent, ToolStats, TrajectoryV2 } from './schema-v2.js';

// v1 interface kept for backwards compatibility with existing tests/cases files
export interface TrajectoryCase {
  id: number;
  label: 'good' | 'bad';
  task: Record<string, unknown>;
  linked_msg_ids: number[];
  messages: Record<string, unknown>[];
  tool_metrics: Record<string, unknown>[];
  metrics: {
    tool_calls: number;
    duration_ms: number | null;
    traceability_score: number;
    has_commit: boolean;
  };
  // v2 fields merged in
  schema_version?: 2;
  agents?: Record<string, AgentTrajectory>;
  blocked_events?: BlockedEvent[];
  raw?: { messages: Record<string, unknown>[]; tool_metrics: Record<string, unknown>[] };
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

function p90(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(0.9 * sorted.length)];
}

function aggregateByAgent(
  toolMetrics: any[],
  agentRoleMap: Map<string, string>,
  messages: any[],
): Record<string, AgentTrajectory> {
  // Collect all tool calls per agent
  const agentData: Map<string, {
    durations: number[];
    toolDurations: Map<string, number[]>;
    toolErrors: Map<string, number>;
  }> = new Map();

  for (const m of toolMetrics) {
    const agentId: string = m.synapse_agent_id;
    if (!agentData.has(agentId)) {
      agentData.set(agentId, {
        durations: [],
        toolDurations: new Map(),
        toolErrors: new Map(),
      });
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

  // Count messages per agent
  const messagesIn: Map<string, number>  = new Map();
  const messagesOut: Map<string, number> = new Map();
  for (const msg of messages) {
    const from: string = msg.from_id;
    const to: string   = msg.to_id;
    if (from !== 'human') messagesOut.set(from, (messagesOut.get(from) ?? 0) + 1);
    if (to   !== 'human') messagesIn.set(to,   (messagesIn.get(to)    ?? 0) + 1);
  }

  // Classify blocked events per agent
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
          p90_ms: p90(durations),
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

  // Find all task IDs that have a case file
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
  const linkedIds = [task.source_msg_id, task.trigger_msg_id, task.result_msg_id].filter(Boolean);

  const messages: Record<string, unknown>[] = (db.prepare(`
    SELECT * FROM messages
    WHERE created_at >= ?
      AND created_at <= COALESCE(?, 9999999999999)
      AND (from_id = ? OR to_id = ?)
    ORDER BY created_at
  `).all(task.started_at, task.finished_at, task.agent_id, task.agent_id) as Record<string, unknown>[]);

  // Prefer direct FK attribution (populated by 12f3c41 worker cookie).
  // Fall back to time-window for legacy rows (task_id IS NULL, pre-migration) and
  // orchestrator-delegated tasks where workers report DONE before FK rows exist.
  // Heuristic: try FK first; if 0 rows, fall back to time-window regardless of age.
  // Both paths are equivalent for orchestrator-only tasks (neither returns worker rows).
  let tool_metrics = db.prepare(`
    SELECT * FROM tool_metrics
    WHERE task_id = ?
    ORDER BY timestamp
  `).all(task.id) as any[];

  if (tool_metrics.length === 0) {
    // Time-window fallback: covers pre-migration rows and orch-only tasks
    tool_metrics = db.prepare(`
      SELECT * FROM tool_metrics
      WHERE synapse_agent_id = ?
        AND timestamp >= ?
        AND timestamp <= COALESCE(?, 9999999999999)
      ORDER BY timestamp
    `).all(task.agent_id, task.started_at, task.finished_at) as any[];
  }

  const missingLinks =
    (task.source_msg_id  ? 0 : 1) +
    (task.trigger_msg_id ? 0 : 1) +
    (task.result_msg_id  ? 0 : 1);

  // Build agent role map: resolve all agent IDs seen in this task window
  const agentIds = new Set<string>([task.agent_id]);
  for (const m of tool_metrics) agentIds.add(m.synapse_agent_id);
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

  const agents = aggregateByAgent(tool_metrics, agentRoleMap, messages);

  // Task-level blocked events (all agents)
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

  const v2: TrajectoryV2 = {
    schema_version: 2,
    task_id: task.id,
    title: task.title ?? '',
    trigger_msg_id: task.trigger_msg_id ?? null,
    source_msg_id: task.source_msg_id ?? null,
    result_msg_id: task.result_msg_id ?? null,
    commit_sha: task.commit_sha ?? null,
    started_at: task.started_at,
    finished_at: task.finished_at ?? null,
    total_duration_ms: (task.started_at && task.finished_at) ? task.finished_at - task.started_at : null,
    agents,
    blocked_events: blockedEvents,
    label: 'good' as const,
    raw: { messages, tool_metrics },
  };

  return {
    id: task.id,
    task,
    linked_msg_ids: linkedIds,
    messages,
    tool_metrics,
    metrics: {
      tool_calls: tool_metrics.length,
      duration_ms: v2.total_duration_ms,
      traceability_score: missingLinks,
      has_commit: !!task.commit_sha,
    },
    ...v2,
  };
}
