import { getEvalResults, getFailedTasksForMetric } from '../db.js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

const METRIC_THRESHOLDS: Record<string, string> = {
  traceability: 'traceability_score must be ≤ 1 (all 3 message links present)',
  tool_calls:   'tool_calls must be ≤ 20',
  duration:     'duration_ms must be ≤ 120 000 ms (2 minutes)',
  has_commit:   'task must produce a git commit',
};

function buildTrajectorySection(taskIds: number[]): string {
  return taskIds.map(id => {
    const rows = getEvalResults(id);
    const summary = rows.map(r => `  ${r.metric}: ${r.passed ? 'pass' : 'FAIL'} (value=${r.value ?? 'n/a'})`).join('\n');
    return `### Task #${id}\n${summary || '  (no eval rows)'}`;
  }).join('\n\n');
}

export async function spawnProposalSession(triggerTaskId: number, triggerMetric: string): Promise<void> {
  const failedTaskIds = getFailedTasksForMetric(triggerMetric, 3);
  const allIds = Array.from(new Set([triggerTaskId, ...failedTaskIds])).slice(0, 3);

  const threshold = METRIC_THRESHOLDS[triggerMetric] ?? triggerMetric;
  const idList = allIds.map(id => `#${id}`).join(', ');
  const timestamp = Date.now();

  const rulesFile = join(process.cwd(), 'templates', 'SYNAPSE-orchestrator.md');
  const currentRules = existsSync(rulesFile) ? readFileSync(rulesFile, 'utf8') : '(file not found)';

  const proposalsDir = join(process.cwd(), '.synapse', 'proposals');
  mkdirSync(proposalsDir, { recursive: true });

  const handoverPath = join(proposalsDir, `handover-${triggerMetric}-${timestamp}.md`);
  const outputProposalPath = join(proposalsDir, `${timestamp}-${triggerMetric}.md`);

  const handoverContent = `# Rule Improvement Request: ${triggerMetric} failures

## Why this proposal was triggered
The metric **${triggerMetric}** has accumulated ${failedTaskIds.length} consecutive failures since the last protocol update.
This proposal should focus specifically on fixing this metric. Do not address other metrics.

You are a Synapse protocol critic. The orchestrator protocol has produced consecutive failures
on the **${triggerMetric}** metric.

## Trigger metric: ${triggerMetric}
## Threshold: ${threshold}
## Failed tasks: ${idList}

## Trajectory data

${buildTrajectorySection(allIds)}

## Current orchestrator rules

${currentRules}

## Your task

Analyze why these 3 trajectories failed on ${triggerMetric}. Propose a focused rule change.

Output EXACTLY this format to \`${outputProposalPath}\`:

\`\`\`
# Proposal: fix ${triggerMetric} failures
Trigger: ${triggerMetric} x3 (tasks ${idList})
Status: pending
Target-file: templates/SYNAPSE-orchestrator.md

## Root cause
<2-3 sentences>

## Proposed rule change
<The exact text to add or modify. Maximum 2 rule sentences. Do not add more.>

## Expected impact
<Which metric improves and why>
\`\`\`

Write ONLY the proposal file. Do not modify any other files.
`;

  writeFileSync(handoverPath, handoverContent, 'utf8');

  const child = spawn('claude', ['--print', '--dangerously-skip-permissions', handoverPath], {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
    env: { ...process.env },
  });
  child.unref();
}
