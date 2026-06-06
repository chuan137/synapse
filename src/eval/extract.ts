import { openDb } from '../db.js';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const BAD_IDS  = [1, 16, 27, 32, 17];
const GOOD_IDS = [39, 43, 51, 52, 53];

export interface TrajectoryCase {
  id: number;
  label: 'good' | 'bad';
  task: Record<string, unknown>;
  messages: Record<string, unknown>[];
  tool_metrics: Record<string, unknown>[];
  metrics: {
    tool_calls: number;
    duration_ms: number | null;
    traceability_score: number; // 0–3: missing source/trigger/result each = +1
    has_commit: boolean;
  };
}

export function extractCases(dbPath: string, outDir: string): TrajectoryCase[] {
  const db = openDb(dbPath);
  const allIds = [...BAD_IDS, ...GOOD_IDS];

  const cases: TrajectoryCase[] = allIds.map(id => {
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
    if (!task) throw new Error(`Task ${id} not found`);

    // Collect linked messages
    const msgIds = [task.source_msg_id, task.trigger_msg_id, task.result_msg_id].filter(Boolean);
    const messages: Record<string, unknown>[] = msgIds.length > 0
      ? (db.prepare(`SELECT * FROM messages WHERE id IN (${msgIds.join(',')})`).all() as Record<string, unknown>[])
      : [];

    // Tool metrics during task window
    const tool_metrics = db.prepare(`
      SELECT * FROM tool_metrics
      WHERE synapse_agent_id = ?
        AND timestamp >= ?
        AND timestamp <= COALESCE(?, 9999999999999)
      ORDER BY timestamp
    `).all(task.agent_id, task.started_at, task.finished_at) as any[];

    const missingLinks =
      (task.source_msg_id  ? 0 : 1) +
      (task.trigger_msg_id ? 0 : 1) +
      (task.result_msg_id  ? 0 : 1);

    return {
      id,
      label: BAD_IDS.includes(id) ? 'bad' : 'good',
      task,
      messages,
      tool_metrics,
      metrics: {
        tool_calls: tool_metrics.length,
        duration_ms: task.started_at && task.finished_at ? task.finished_at - task.started_at : null,
        traceability_score: missingLinks,
        has_commit: !!task.commit_sha,
      },
    };
  });

  db.close();
  mkdirSync(outDir, { recursive: true });
  cases.forEach(c => {
    writeFileSync(join(outDir, `task_${c.id}_${c.label}.json`), JSON.stringify(c, null, 2));
  });
  return cases;
}
