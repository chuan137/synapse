import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { TrajectoryCase } from './extract.js';

export interface EvalResult {
  id: number;
  label: 'good' | 'bad';
  title: string;
  pass: boolean;
  failures: string[];
  metrics: TrajectoryCase['metrics'];
}

const THRESHOLDS = {
  traceability_score: 1,
  tool_calls: 20,
  duration_ms: 120_000,
  has_commit: true,
};

export function evaluateCases(casesDir: string): EvalResult[] {
  const files = readdirSync(casesDir).filter(f => f.endsWith('.json'));
  return files.map(f => {
    const c: TrajectoryCase = JSON.parse(readFileSync(join(casesDir, f), 'utf8'));
    const failures: string[] = [];
    if (c.metrics.traceability_score > THRESHOLDS.traceability_score)
      failures.push(`traceability_missing=${c.metrics.traceability_score} (max ${THRESHOLDS.traceability_score})`);
    if (c.metrics.tool_calls > THRESHOLDS.tool_calls)
      failures.push(`tool_calls=${c.metrics.tool_calls} (max ${THRESHOLDS.tool_calls})`);
    if ((c.metrics.duration_ms ?? 0) > THRESHOLDS.duration_ms)
      failures.push(`duration=${Math.round((c.metrics.duration_ms ?? 0)/1000)}s (max 120s)`);
    if (!c.metrics.has_commit)
      failures.push('no_commit');
    return {
      id: c.id,
      label: c.label,
      title: (c.task as any).title ?? '',
      pass: failures.length === 0,
      failures,
      metrics: c.metrics,
    };
  }).sort((a, b) => a.id - b.id);
}
