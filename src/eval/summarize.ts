/**
 * LLM summarizer: ingests retros, window reports, and critic patches
 * to produce concrete proposals (protocol patches, skills, threshold adjustments).
 *
 * Usage:
 *   import { generateSummary } from './summarize.js';
 *   const report = await generateSummary({ since: '2w' });
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseDuration } from './window.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Proposal {
  category: 'protocol_patch' | 'new_skill' | 'threshold_adjustment' | 'role_tweak';
  target_file?: string;
  title: string;
  body: string;
  evidence: string[];
  impact_estimate: string;
}

export interface SummaryReport {
  proposals: Proposal[];
  sources: {
    retros: number;
    window_reports: number;
    gate_verdicts: number;
    patches: number;
  };
  outputPath: string;
}

export interface SummarizeOptions {
  since?: string;
  outputPath?: string;
  model?: string;
  dryRun?: boolean;
}

// ── Source collection ─────────────────────────────────────────────────────────

function collectSources(since: string) {
  const cutoff = Date.now() - parseDuration(since);
  const cwd = process.cwd();

  function filesIn(dir: string, pattern: RegExp): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(f => pattern.test(f))
      .map(f => join(dir, f));
  }

  function filterByMtime(files: string[]): string[] {
    return files.filter(f => {
      try {
        return statSync(f).mtimeMs >= cutoff;
      } catch { return true; }
    });
  }

  // Retros: .synapse/retros/*.md
  const retroDir = join(cwd, '.synapse', 'retros');
  const retros = filterByMtime(filesIn(retroDir, /\.md$/));

  // Window reports: .synapse/reports/*-window-*.md
  const reportsDir = join(cwd, '.synapse', 'reports');
  const windowReports = filterByMtime(filesIn(reportsDir, /-window-.*\.md$/));

  // Gate verdicts with deploy_recommended: true
  const gateDir = join(cwd, 'tests', 'gate_results');
  const gateVerdicts = filesIn(gateDir, /gate_.*\.json$/).filter(f => {
    try {
      const g = JSON.parse(readFileSync(f, 'utf8'));
      return g.deploy_recommended === true;
    } catch { return false; }
  });

  // Critic patches (with frontmatter, from gate-approved set or all recent)
  const patchDir = join(cwd, 'tests', 'patches');
  const patches = filterByMtime(filesIn(patchDir, /_patch\.md$/));

  return { retros, windowReports, gateVerdicts, patches };
}

// ── Prompt builder ────────────────────────────────────────────────────────────

const PROPOSAL_BLOCK_RE = /### Proposal \d+: ([^\n]+)\n([\s\S]+?)(?=### Proposal \d+:|## Raw sources|$)/g;

function buildPrompt(sources: ReturnType<typeof collectSources>): string {
  const MAX_SECTION = 4000;  // chars per source section

  const retroText = sources.retros.map(f =>
    `\n--- Retro: ${f} ---\n${readFileSync(f, 'utf8').slice(0, 1500)}`
  ).join('\n').slice(0, MAX_SECTION) || '(no retros found)';

  const windowText = sources.windowReports.map(f =>
    `\n--- Window report: ${f} ---\n${readFileSync(f, 'utf8').slice(0, 1500)}`
  ).join('\n').slice(0, MAX_SECTION) || '(no window reports found)';

  const patchText = sources.gateVerdicts.map(f => {
    const g = JSON.parse(readFileSync(f, 'utf8'));
    const patchFile = g.patch_file;
    const body = existsSync(patchFile) ? readFileSync(patchFile, 'utf8').slice(0, 800) : '(missing)';
    return `\n--- Approved patch: ${patchFile} (role: ${g.target_role ?? 'cross-role'}, metric: ${g.failure_metric ?? '?'}) ---\n${body}`;
  }).join('\n').slice(0, MAX_SECTION) || '(no gate-approved patches)';

  const recentPatchText = sources.patches
    .filter(f => !sources.gateVerdicts.some(g => {
      const gate = JSON.parse(readFileSync(g, 'utf8'));
      return gate.patch_file === f;
    }))
    .slice(0, 5)
    .map(f => `\n--- Critic patch: ${f} ---\n${readFileSync(f, 'utf8').slice(0, 500)}`)
    .join('\n').slice(0, 2000) || '';

  return `You are a process auditor for a multi-agent orchestration system called Synapse.
Your job is to find concrete leverage points — protocol changes, new skills, or threshold adjustments — that would prevent the most repeated friction.
You are NOT writing a status update. You are identifying systemic issues with specific fixes.

## Source material

### Orchestrator retros (recent):
${retroText}

### Window reports (recent aggregate metrics):
${windowText}

### Gate-approved critic patches (proven improvements):
${patchText}
${recentPatchText ? `\n### Additional critic patches (not yet gate-approved):\n${recentPatchText}` : ''}

## Your output

Produce UP TO 5 proposals. Each must:
1. Be CONCRETE: specify the exact file/rule/threshold to change, not just "improve X"
2. Cite at LEAST 2 pieces of evidence from the sources above (use file paths or specific data points)
3. Provide an impact estimate, even if rough (e.g., "addresses 3 of last 10 traceability failures")
4. Fit one of these categories: protocol_patch | new_skill | threshold_adjustment | role_tweak

FORBIDDEN: vague proposals like "be more careful", "improve communication", "consider X"

Format each proposal EXACTLY like this:

### Proposal N: <one-line title>
**Category:** protocol_patch | new_skill | threshold_adjustment | role_tweak
**Target:** <file path or skill name>
**Evidence:** <citation 1> | <citation 2>
**Impact:** <estimate>

<2-4 sentence explanation of what to change, why, and what specifically improves>

---

If you have fewer than 5 real proposals, output fewer. Do NOT pad with weak proposals to reach 5.
If sources are empty or insufficient for concrete proposals, output a single proposal block:
### Proposal 1: Collect more data
**Category:** role_tweak
**Target:** n/a
**Evidence:** (insufficient sources)
**Impact:** n/a
More source data needed before concrete proposals can be made.`;
}

// ── Proposal parser ───────────────────────────────────────────────────────────

function parseProposals(llmOutput: string): Proposal[] {
  const proposals: Proposal[] = [];
  let match: RegExpExecArray | null;

  const re = /### Proposal \d+: ([^\n]+)\n([\s\S]+?)(?=\n### Proposal \d+:|\n## |\n---\n*$|$)/g;
  while ((match = re.exec(llmOutput)) !== null) {
    const title = match[1].trim();
    const block = match[2];

    const get = (label: string) => {
      const m = block.match(new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`));
      return m ? m[1].trim() : '';
    };

    const categoryRaw = get('Category').toLowerCase().replace(/[^a-z_]/g, '_').replace(/__+/g, '_').trim();
    const category = (['protocol_patch', 'new_skill', 'threshold_adjustment', 'role_tweak'] as const)
      .find(c => categoryRaw.includes(c.replace('_', ''))) ?? 'protocol_patch';

    const evidenceRaw = get('Evidence');
    const evidence = evidenceRaw.split('|').map(e => e.trim()).filter(Boolean);

    // Body = everything after the metadata lines
    const body = block
      .replace(/\*\*Category:\*\*[^\n]+\n?/, '')
      .replace(/\*\*Target:\*\*[^\n]+\n?/, '')
      .replace(/\*\*Evidence:\*\*[^\n]+\n?/, '')
      .replace(/\*\*Impact:\*\*[^\n]+\n?/, '')
      .replace(/^---\s*$/m, '')
      .trim();

    proposals.push({
      category: category as Proposal['category'],
      target_file: get('Target') || undefined,
      title,
      body,
      evidence: evidence.length > 0 ? evidence : ['(no citations provided)'],
      impact_estimate: get('Impact') || 'unknown',
    });
  }

  return proposals;
}

// ── Markdown report builder ───────────────────────────────────────────────────

function buildMarkdownReport(
  proposals: Proposal[],
  sources: ReturnType<typeof collectSources>,
  since: string,
  rawOutput: string,
): string {
  const now = new Date().toISOString();
  const proposalMd = proposals.map((p, i) => `### ${i + 1}. ${p.title} [${p.category}]
**Target:** ${p.target_file ?? 'n/a'}
**Evidence:** ${p.evidence.join(' | ')}
**Impact:** ${p.impact_estimate}

${p.body}

---`).join('\n\n');

  const sourceIndex = [
    ...sources.retros.map(f => `- Retro: ${f}`),
    ...sources.windowReports.map(f => `- Window report: ${f}`),
    ...sources.gateVerdicts.map(f => `- Gate verdict: ${f}`),
    ...sources.patches.map(f => `- Critic patch: ${f}`),
  ].join('\n') || '(none)';

  return `# Synapse summary — ${now.slice(0, 10)} — ${since}

_Generated at ${now}_

## Sources analyzed

- Retros: ${sources.retros.length}
- Window reports: ${sources.windowReports.length}
- Critic patches (gate-approved): ${sources.gateVerdicts.length}
- Critic patches (all): ${sources.patches.length}

## Proposals (${proposals.length})

${proposalMd || '_No proposals generated — insufficient source data._'}

## Raw sources index

${sourceIndex}
`.trimEnd() + '\n';
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function generateSummary(opts: SummarizeOptions = {}): Promise<SummaryReport> {
  const since = opts.since ?? '2w';
  const model = opts.model ?? 'claude-sonnet-4-6';
  const reportsDir = join(process.cwd(), '.synapse', 'reports');
  const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
  const outputPath = opts.outputPath ?? join(reportsDir, `${ts}-summary.md`);
  const jsonPath = outputPath.replace(/\.md$/, '.json');

  const sources = collectSources(since);
  const prompt = buildPrompt(sources);

  if (opts.dryRun) {
    process.stdout.write(`=== Dry run ===\n`);
    process.stdout.write(`Since: ${since}\n`);
    process.stdout.write(`Retros: ${sources.retros.length} files\n`);
    process.stdout.write(`Window reports: ${sources.windowReports.length} files\n`);
    process.stdout.write(`Gate verdicts (deploy_recommended): ${sources.gateVerdicts.length} files\n`);
    process.stdout.write(`Critic patches: ${sources.patches.length} files\n`);
    process.stdout.write(`Estimated prompt size: ~${Math.round(prompt.length / 4)} tokens (${prompt.length} chars)\n`);
    process.stdout.write(`Output would go to: ${outputPath}\n`);
    return {
      proposals: [],
      sources: { retros: sources.retros.length, window_reports: sources.windowReports.length, gate_verdicts: sources.gateVerdicts.length, patches: sources.patches.length },
      outputPath,
    };
  }

  const client = new Anthropic();
  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const rawOutput = (response.content[0] as any).text as string;
  const proposals = parseProposals(rawOutput);
  const markdown = buildMarkdownReport(proposals, sources, since, rawOutput);

  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(outputPath, markdown);

  const report: SummaryReport = {
    proposals,
    sources: {
      retros: sources.retros.length,
      window_reports: sources.windowReports.length,
      gate_verdicts: sources.gateVerdicts.length,
      patches: sources.patches.length,
    },
    outputPath,
  };
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  return report;
}
