import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export type Family = 'haiku' | 'sonnet' | 'opus';

const ROLE_FAMILY: Record<string, Family> = {
  orchestrator:    'opus',
  'test-runner':   'haiku',
  developer:       'sonnet',
  'code-reviewer': 'sonnet',
  planner:         'sonnet',
  'doc-writer':    'sonnet',
};

export const KNOWN_ROLES = Object.keys(ROLE_FAMILY);

const settingsCache = new Map<string, Record<string, string>>();

function readEnvBlock(path: string): Record<string, string> {
  if (settingsCache.has(path)) return settingsCache.get(path)!;
  let result: Record<string, string> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof parsed?.env === 'object' && parsed.env !== null) {
        result = parsed.env as Record<string, string>;
      }
    } catch { /* ignore parse errors */ }
  }
  settingsCache.set(path, result);
  return result;
}

export interface FamilyResolution {
  model: string;
  source: string;
}

/** Resolve the model name for a family from env → project settings → global settings → fallback. */
export function resolveFamily(family: Family, cwd = process.cwd()): FamilyResolution {
  const key = `ANTHROPIC_DEFAULT_${family.toUpperCase()}_MODEL`;

  if (process.env[key]) return { model: process.env[key]!, source: 'env' };

  const projectClaudeDir = join(cwd, '.claude');
  for (const file of ['settings.local.json', 'settings.json']) {
    const val = readEnvBlock(join(projectClaudeDir, file))[key];
    if (val) return { model: val, source: file };
  }

  const globalClaudeDir = join(homedir(), '.claude');
  const val = readEnvBlock(join(globalClaudeDir, 'settings.json'))[key];
  if (val) return { model: val, source: '~/.claude/settings.json' };

  return { model: `claude-${family}-latest`, source: 'fallback' };
}

/** Resolve the model name for a role. */
export function resolveModelForRole(role: string, cwd = process.cwd()): string {
  const family = ROLE_FAMILY[role] ?? 'sonnet';
  return resolveFamily(family, cwd).model;
}

/** Return family→resolution and role→family→model for display. */
export function resolveAllModels(cwd = process.cwd()): {
  families: { family: Family; model: string; source: string }[];
  roles: { role: string; family: Family; model: string }[];
} {
  const families = (['haiku', 'sonnet', 'opus'] as Family[]).map(family => ({
    family,
    ...resolveFamily(family, cwd),
  }));

  const familyModel = Object.fromEntries(families.map(f => [f.family, f.model]));

  const roles = KNOWN_ROLES.map(role => {
    const family = ROLE_FAMILY[role] ?? 'sonnet';
    return { role, family, model: familyModel[family] };
  });

  return { families, roles };
}
