#!/usr/bin/env node
import { Command } from 'commander';
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

function buildSystemPrompt(role: 'orchestrator' | 'worker'): string {
  const templatesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
  const base = readFileSync(join(templatesDir, 'SYNAPSE.md'), 'utf8');
  const roleFile = role === 'orchestrator' ? 'SYNAPSE-orchestrator.md' : 'SYNAPSE-worker.md';
  const roleInstructions = readFileSync(join(templatesDir, roleFile), 'utf8');
  return base
    .replace('{ROLE}', role)
    .replace('{ROLE_INSTRUCTIONS}', roleInstructions);
}

const SYNAPSE_INSTALL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function synapseInit(projectRoot: string, silent = false): boolean {
  const synapseDir = join(projectRoot, '.synapse');
  const isNew = !existsSync(join(synapseDir, 'synapse.db'));

  mkdirSync(synapseDir, { recursive: true });

  // Copy instruction templates into .synapse/ (always refresh)
  for (const f of ['SYNAPSE.md', 'SYNAPSE-orchestrator.md', 'SYNAPSE-worker.md']) {
    copyFileSync(join(SYNAPSE_INSTALL_ROOT, 'templates', f), join(synapseDir, f));
  }

  // Copy hook script
  const hookDest = join(synapseDir, 'synapse-hook.sh');
  copyFileSync(join(SYNAPSE_INSTALL_ROOT, 'scripts', 'synapse-hook.sh'), hookDest);
  chmodSync(hookDest, 0o755);

  // Patch .gitignore
  const gitignorePath = join(projectRoot, '.gitignore');
  const gitignore = existsSync(gitignorePath) ? readFileSync(gitignorePath, 'utf8') : '';
  if (!gitignore.includes('.synapse/')) {
    writeFileSync(gitignorePath, gitignore + (gitignore.endsWith('\n') ? '' : '\n') + '.synapse/\n', 'utf8');
  }

  // Patch CLAUDE.md
  const claudeMd = join(projectRoot, 'CLAUDE.md');
  const claudeContent = existsSync(claudeMd) ? readFileSync(claudeMd, 'utf8') : '';
  const synapseBlock = `\n## Synapse\n\nThis project uses Synapse for multi-agent orchestration.\nRead \`.synapse/SYNAPSE.md\` for the agent protocol.\nIf your slot is \`:0\`, also read \`.synapse/SYNAPSE-orchestrator.md\`.\nIf your slot is \`:1\` or higher, also read \`.synapse/SYNAPSE-worker.md\`.\n`;
  if (!claudeContent.includes('## Synapse')) {
    writeFileSync(claudeMd, claudeContent + synapseBlock, 'utf8');
  }

  // Register PostToolUse hook in .claude/settings.json
  const claudeDir = join(projectRoot, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const claudeSettings = join(claudeDir, 'settings.json');
  const existing = existsSync(claudeSettings)
    ? JSON.parse(readFileSync(claudeSettings, 'utf8'))
    : {};
  const hookCommand = `bash ${join(synapseDir, 'synapse-hook.sh')}`;
  const hooks = existing.hooks ?? {};
  const postToolUse: { matcher: string; hooks: { type: string; command: string }[] }[] =
    hooks.PostToolUse ?? [];
  const alreadyRegistered = postToolUse.some(h =>
    h.hooks?.some(hh => hh.command === hookCommand)
  );
  if (!alreadyRegistered) {
    postToolUse.push({ matcher: '', hooks: [{ type: 'command', command: hookCommand }] });
    existing.hooks = { ...hooks, PostToolUse: postToolUse };
    writeFileSync(claudeSettings, JSON.stringify(existing, null, 2), 'utf8');
  }

  if (!silent) {
    process.stdout.write(isNew
      ? `[Synapse] Initialized at ${projectRoot}\n`
      : `[Synapse] Already initialized at ${projectRoot}\n`
    );
  }

  return isNew;
}

const program = new Command();

program
  .name('synapse')
  .description('Synapse CLI: Terminal-First Multi-Agent Orchestrator')
  .version('2.0.0');

program
  .command('init [path]')
  .description('Initialize Synapse in a project directory')
  .action((targetPath) => {
    synapseInit(resolve(targetPath ?? '.'), false);
  });

program
  .command('run')
  .description('Start a Claude session with Synapse system prompt injected')
  .option('--role <role>', 'Agent role: orchestrator or worker', 'orchestrator')
  .option('--slot <slot>', 'Reuse a specific slot, e.g. --slot 0')
  .option('--task <task>', 'Task prompt for worker agents')
  .option('--task-file <file>', 'File containing task prompt for worker agents')
  .action((options) => {
    const role = options.role as 'orchestrator' | 'worker';
    const systemPrompt = buildSystemPrompt(role);
    const cwd = process.cwd();
    if (options.slot !== undefined) {
      process.env.SYNAPSE_SLOT = String(options.slot);
    }

    const claudeArgs = ['--append-system-prompt', systemPrompt];
    if (role === 'worker') {
      claudeArgs.push('--dangerously-skip-permissions');
      claudeArgs.push('--allowedTools', 'mcp__synapse-bus__read_messages,mcp__synapse-bus__send_message,mcp__synapse-bus__update_status,mcp__synapse-bus__spawn_agent,mcp__synapse-bus__request_approval');
      claudeArgs.push('--add-dir', cwd);
    }
    const task = options.task
      ?? (options.taskFile ? readFileSync(options.taskFile, 'utf8') : null);
    if (task) {
      claudeArgs.push('--print', task);
    }
    execFileSync('claude', claudeArgs, { stdio: 'inherit' });
  });

program
  .command('mcp')
  .description('Start the MCP server (stdio transport, for editor integration)')
  .action(async () => {
    const { startMcpServer } = await import('./mcp-server.js');
    await startMcpServer();
  });

program
  .command('dash', { isDefault: true })
  .description('Open the S-Deck dashboard for the current project')
  .option('-p, --port <number>', 'Dashboard port (0 = random free port)', '0')
  .action(async (options) => {
    const isNew = synapseInit(process.cwd(), true);
    if (isNew) process.stderr.write(`[Synapse] Initialized project at ${process.cwd()}\n`);
    const { db } = await import('./db.js');
    const { startDashboard } = await import('./dashboard.js');

    function shutdown() {
      db.close();
      process.exit(0);
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await startDashboard(Number(options.port));
  });

program.parse(process.argv);
