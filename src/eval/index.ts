import { extractCases } from './extract.js';
import { join } from 'path';

const dbPath = join(process.cwd(), '.synapse', 'synapse.db');
const outDir = join(process.cwd(), 'tests', 'cases');

console.log('Extracting trajectory cases...');
const cases = extractCases(dbPath, outDir);
cases.forEach(c => {
  console.log(`[${c.label.toUpperCase()}] Task #${c.id}: ${(c.task as any).title?.slice(0, 50)}`);
  console.log(`  tool_calls=${c.metrics.tool_calls} duration=${Math.round((c.metrics.duration_ms ?? 0)/1000)}s traceability_missing=${c.metrics.traceability_score} commit=${c.metrics.has_commit}`);
});
console.log(`\nWritten ${cases.length} cases to ${outDir}`);
