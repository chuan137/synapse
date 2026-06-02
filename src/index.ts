#!/usr/bin/env node
import { Command } from 'commander';
import { copyFileSync, existsSync, mkdirSync } from 'fs';
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

    process.stdout.write(isNew
      ? `Synapse initialized at ${projectRoot}\n`
      : `Synapse already initialized at ${projectRoot}\n`
    );
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
