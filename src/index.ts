#!/usr/bin/env node
import { Command } from 'commander';
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const SYNAPSE_INSTALL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const program = new Command();

program
  .name('synapse')
  .description('Synapse CLI: Terminal-First Multi-Agent Orchestrator')
  .version('2.0.0');

program
  .command('init [path]')
  .description('Initialize Synapse in a project directory')
  .action((targetPath) => {
    const projectRoot = resolve(targetPath ?? '.');
    const dbPath = join(projectRoot, '.synapse', 'synapse.db');
    const isNew = !existsSync(dbPath);

    if (isNew) {
      mkdirSync(join(projectRoot, '.synapse'), { recursive: true });
    }

    const synapseDoc = join(projectRoot, 'SYNAPSE.md');
    if (!existsSync(synapseDoc)) {
      copyFileSync(join(SYNAPSE_INSTALL_ROOT, 'SYNAPSE.md'), synapseDoc);
    }

    const hookDest = join(projectRoot, '.synapse', 'synapse-hook.sh');
    if (!existsSync(hookDest)) {
      copyFileSync(join(SYNAPSE_INSTALL_ROOT, 'scripts', 'synapse-hook.sh'), hookDest);
      chmodSync(hookDest, 0o755);
    }

    // Register PostToolUse hook in .claude/settings.json
    const claudeDir = join(projectRoot, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const claudeSettings = join(claudeDir, 'settings.json');
    const existing = existsSync(claudeSettings)
      ? JSON.parse(readFileSync(claudeSettings, 'utf8'))
      : {};
    const hookCommand = 'bash .synapse/synapse-hook.sh';
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

    process.stdout.write(isNew
      ? `Synapse initialized at ${projectRoot}\n`
      : `Synapse already initialized at ${projectRoot}\n`
    );
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
