import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { evaluateCases } from './evaluator.js';
import { parsePatchMeta } from './patch.js';

export interface GateResult {
  patch_file: string;
  target_role: string | null;
  target_file: string;
  regression_pass: boolean;
  coverage_verdict: string;
  coverage_verdict_role: boolean;  // patch logically addresses the per-role failure
  deploy_recommended: boolean;
}

export async function runGate(
  patchFile: string,
  casesDir: string,
  currentRulesFile: string,
  outDir: string
): Promise<GateResult> {
  const patchContent = readFileSync(patchFile, 'utf8');
  const currentRules = readFileSync(currentRulesFile, 'utf8');
  const { meta, body: patchBody } = parsePatchMeta(patchContent);

  // 1. Regression check: re-evaluate good cases.
  //    Role-specific patch: only re-check cases where the affected role appears.
  //    Cross-role patch: re-check all good cases.
  const allResults = evaluateCases(casesDir);
  const goodResults = allResults.filter(r => r.label === 'good');

  let regressionResults = goodResults;
  if (meta.target_role) {
    // Filter to cases where this role was involved as primary agent
    regressionResults = goodResults.filter(r =>
      r.role === meta.target_role || r.role === null  // null = unknown role, check to be safe
    );
  }

  const regressionPass = regressionResults.length === 0 || regressionResults.every(r => r.pass);

  // 2. Coverage check: ask Claude if the patch addresses the failure.
  const roleContext = meta.target_role
    ? `This patch targets the **${meta.target_role}** role and addresses the **${meta.failure_metric}** metric.`
    : `This is a cross-role patch addressing **${meta.failure_metric}**.`;

  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `Does the following proposed rule patch adequately address the per-role failure described in it?

${roleContext}

Current rules excerpt (${meta.target_file}):
${currentRules.slice(0, 2000)}

Proposed patch:
${patchBody.slice(0, 2000)}

Answer with:
VERDICT: ADEQUATE or INADEQUATE
ROLE_ADDRESSED: YES or NO  (does the patch logically target the ${meta.target_role ?? 'cross-role'} failure, not just the symptom?)
REASON: (one sentence)`,
    }],
  });

  const verdict = (response.content[0] as any).text as string;
  const adequate = verdict.includes('VERDICT: ADEQUATE') && !verdict.includes('VERDICT: INADEQUATE');
  const roleAddressed = verdict.includes('ROLE_ADDRESSED: YES');

  const result: GateResult = {
    patch_file: patchFile,
    target_role: meta.target_role,
    target_file: meta.target_file,
    regression_pass: regressionPass,
    coverage_verdict: verdict.trim(),
    coverage_verdict_role: roleAddressed,
    deploy_recommended: regressionPass && adequate && roleAddressed,
  };

  mkdirSync(outDir, { recursive: true });
  const slug = patchFile.replace(/.*[\\/]/, '').replace('.md', '');
  const outFile = join(outDir, `gate_${slug}.json`);
  writeFileSync(outFile, JSON.stringify(result, null, 2));
  return result;
}
