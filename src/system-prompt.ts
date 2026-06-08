import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function stripFrontMatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n*/, '');
}

export function buildSystemPrompt(role: string): string {
  const templatesDir = join(__dirname, '..', 'templates');
  const base = readFileSync(join(templatesDir, 'SYNAPSE.md'), 'utf8');

  let roleInstructions: string;
  let roleLabel: string;

  if (role === 'orchestrator') {
    roleInstructions = readFileSync(join(templatesDir, 'SYNAPSE-orchestrator.md'), 'utf8');
    roleLabel = 'orchestrator';
  } else if (role === 'worker') {
    roleInstructions = readFileSync(join(templatesDir, 'SYNAPSE-worker.md'), 'utf8');
    roleLabel = 'worker';
  } else {
    const workerBase = readFileSync(join(templatesDir, 'SYNAPSE-worker.md'), 'utf8');
    const roleFile = join(templatesDir, 'roles', `${role}.md`);
    const roleOverlay = existsSync(roleFile)
      ? '\n\n' + stripFrontMatter(readFileSync(roleFile, 'utf8'))
      : '';
    roleInstructions = workerBase + roleOverlay;
    roleLabel = 'worker';
  }

  return base
    .replace('{ROLE}', roleLabel)
    .replace('{ROLE_INSTRUCTIONS}', roleInstructions);
}
