import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { TrajectoryCase } from './extract.js';

export async function runCritic(
  caseFile: string,
  rulesFile: string,
  outDir: string
): Promise<string> {
  const traj: TrajectoryCase = JSON.parse(readFileSync(caseFile, 'utf8'));
  const rules = readFileSync(rulesFile, 'utf8');
  const task = traj.task as any;

  const prompt = `You are a critic reviewing a failed AI agent trajectory in the Synapse multi-agent system.

## Failed Trajectory

Task #${traj.id}: "${task.title}"
Status: ${task.status}
Agent: ${task.agent_id}
Duration: ${Math.round((traj.metrics.duration_ms ?? 0) / 1000)}s
Tool calls: ${traj.metrics.tool_calls}
Traceability missing fields: ${traj.metrics.traceability_score}/3
  - source_msg_id: ${task.source_msg_id ? 'present' : 'MISSING'}
  - trigger_msg_id: ${task.trigger_msg_id ? 'present' : 'MISSING'}
  - result_msg_id: ${task.result_msg_id ? 'present' : 'MISSING'}
Has commit: ${traj.metrics.has_commit}

## Messages linked to this task
${traj.messages.map((m: any) => `[${m.from_id} → ${m.to_id}]: ${String(m.content).slice(0, 200)}`).join('\n')}

## Current orchestrator rules (SYNAPSE-orchestrator.md)
${rules}

## Your task

Identify the most likely reason this trajectory failed (missing traceability fields, excessive tool calls, no commit, etc.).

Then propose a SPECIFIC addition or edit to the orchestrator rules that would have prevented this failure. Output:

1. **Root cause** (2-3 sentences)
2. **Proposed rule change** (exact text to add/modify in SYNAPSE-orchestrator.md, formatted as a diff or clearly marked addition)
3. **Expected impact** (what metric improves and by how much)

Be concrete and actionable. Do not suggest vague "be more careful" rules.`;

  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const patch = (response.content[0] as any).text as string;

  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `task_${traj.id}_patch.md`);
  writeFileSync(outFile, `# Critic patch for Task #${traj.id}\n\n${patch}\n`);
  return patch;
}
