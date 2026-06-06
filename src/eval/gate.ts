import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { evaluateCases } from './evaluator.js';

export interface GateResult {
  patch_file: string;
  regression_pass: boolean;
  coverage_verdict: string;
  deploy_recommended: boolean;
}

export async function runGate(
  patchFile: string,
  casesDir: string,
  currentRulesFile: string,
  outDir: string
): Promise<GateResult> {
  const patch = readFileSync(patchFile, 'utf8');
  const currentRules = readFileSync(currentRulesFile, 'utf8');

  // 1. Regression check: re-evaluate all good cases (metrics unchanged — just verify)
  const allResults = evaluateCases(casesDir);
  const goodResults = allResults.filter(r => r.label === 'good');
  const regressionPass = goodResults.every(r => r.pass);

  // 2. Coverage check: ask Claude if the patch addresses the failure
  const client = new Anthropic();
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `Does the following proposed rule patch adequately address the failure described in it?

Current rules excerpt (SYNAPSE-orchestrator.md):
${currentRules.slice(0, 2000)}

Proposed patch:
${patch.slice(0, 2000)}

Answer with:
VERDICT: ADEQUATE or INADEQUATE
REASON: (one sentence)`,
    }],
  });

  const verdict = (response.content[0] as any).text as string;
  const adequate = verdict.includes('ADEQUATE') && !verdict.includes('INADEQUATE');

  const result: GateResult = {
    patch_file: patchFile,
    regression_pass: regressionPass,
    coverage_verdict: verdict.trim(),
    deploy_recommended: regressionPass && adequate,
  };

  mkdirSync(outDir, { recursive: true });
  const slug = patchFile.replace(/.*[\\/]/, '').replace('.md', '');
  const outFile = join(outDir, `gate_${slug}.json`);
  writeFileSync(outFile, JSON.stringify(result, null, 2));
  return result;
}
