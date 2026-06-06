import { extractCases } from './extract.js';
import { evaluateCases } from './evaluator.js';
import { writeFileSync } from 'fs';
import { join } from 'path';

const dbPath = join(process.cwd(), '.synapse', 'synapse.db');
const casesDir = join(process.cwd(), 'tests', 'cases');
const reportPath = join(process.cwd(), 'tests', 'eval_report.json');

console.log('Extracting trajectory cases...');
extractCases(dbPath, casesDir);

console.log('\nEvaluating trajectories...');
const results = evaluateCases(casesDir);

const passed = results.filter(r => r.pass);
const failed = results.filter(r => !r.pass);

console.log(`\n=== EVAL REPORT ===`);
console.log(`PASS: ${passed.length}/${results.length}`);
failed.forEach(r => {
  console.log(`  FAIL [${r.label.toUpperCase()}] #${r.id} ${r.title.slice(0, 45)}`);
  r.failures.forEach(f => console.log(`    - ${f}`));
});
passed.forEach(r => {
  console.log(`  PASS [${r.label.toUpperCase()}] #${r.id} ${r.title.slice(0, 45)}`);
});

writeFileSync(reportPath, JSON.stringify(results, null, 2));
console.log(`\nReport written to ${reportPath}`);
