/**
 * Shared utilities for patch files produced by the critic.
 *
 * Patch files use YAML-style frontmatter:
 *   ---
 *   target_file: templates/SYNAPSE-developer.md
 *   target_role: developer
 *   failure_metric: tool_calls
 *   ---
 */

export interface PatchMeta {
  target_file: string;    // e.g. templates/SYNAPSE-developer.md
  target_role: string | null;  // null = cross-role patch targets SYNAPSE.md
  failure_metric: string; // e.g. tool_calls, has_commit, traceability_score
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

export function parsePatchMeta(content: string): { meta: PatchMeta; body: string } {
  const m = content.match(FRONTMATTER_RE);
  if (!m) {
    return {
      meta: { target_file: 'templates/SYNAPSE.md', target_role: null, failure_metric: 'unknown' },
      body: content,
    };
  }
  const raw = m[1];
  const body = m[2].trim();
  const meta: Partial<PatchMeta> = {};
  for (const line of raw.split('\n')) {
    const [k, ...v] = line.split(':');
    if (k && v.length) {
      const key = k.trim();
      const val = v.join(':').trim().replace(/^["']|["']$/g, '');
      if (key === 'target_file') meta.target_file = val;
      else if (key === 'target_role') meta.target_role = val === 'null' ? null : val;
      else if (key === 'failure_metric') meta.failure_metric = val;
    }
  }
  return {
    meta: {
      target_file: meta.target_file ?? 'templates/SYNAPSE.md',
      target_role: meta.target_role ?? null,
      failure_metric: meta.failure_metric ?? 'unknown',
    },
    body,
  };
}

export function buildPatchFrontmatter(meta: PatchMeta): string {
  return `---\ntarget_file: ${meta.target_file}\ntarget_role: ${meta.target_role ?? 'null'}\nfailure_metric: ${meta.failure_metric}\n---\n`;
}

export function roleToTemplateFile(role: string | null): string {
  if (!role || role === 'task' || role === 'unknown') return 'templates/SYNAPSE.md';
  const fileMap: Record<string, string> = {
    orchestrator:    'templates/SYNAPSE-orchestrator.md',
    developer:       'templates/SYNAPSE-worker.md',
    'code-reviewer': 'templates/SYNAPSE-worker.md',
    'doc-writer':    'templates/SYNAPSE-worker.md',
    'test-runner':   'templates/SYNAPSE-worker.md',
  };
  return fileMap[role] ?? 'templates/SYNAPSE.md';
}
