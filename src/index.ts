#!/usr/bin/env node
import { Command } from 'commander';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { exec, execFileSync, execSync } from 'child_process';
import { openDb, attachCommitToTaskBySlot } from './db.js';

/** Strip YAML front-matter (---...---) from a role file before injecting into system prompt. */
function stripFrontMatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n*/, '');
}

/** Parse role metadata from a role file's front-matter. Returns null if no front-matter. */
function parseRoleMeta(content: string): { role: string; description: string; capabilities: string[] } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const block = match[1];
  const role = (block.match(/^role:\s*(.+)$/m) ?? [])[1]?.trim() ?? '';
  const description = (block.match(/^description:\s*(.+)$/m) ?? [])[1]?.trim() ?? '';
  const capMatch = block.match(/^capabilities:\s*\[([^\]]*)\]/m);
  const capabilities = capMatch ? capMatch[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')) : [];
  return { role, description, capabilities };
}

function buildSystemPrompt(role: string): string {
  const templatesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
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
    // Named worker role — base worker instructions + role-specific overlay (front-matter stripped)
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

/** List all available named roles from templates/roles/, returning their metadata. */
function listAvailableRoles(templatesDir: string): { role: string; description: string; capabilities: string[] }[] {
  const rolesDir = join(templatesDir, 'roles');
  if (!existsSync(rolesDir)) return [];
  return readdirSync(rolesDir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const content = readFileSync(join(rolesDir, f), 'utf8');
      return parseRoleMeta(content);
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
}

const SYNAPSE_INSTALL_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function synapseInit(projectRoot: string, silent = false, update = false): boolean {
  const synapseDir = join(projectRoot, '.synapse');
  // Determine newness from a file synapseInit itself writes (the copied protocol
  // template), captured BEFORE the copy loop below recreates it. The DB and
  // .synapse/settings.json are created lazily by the bus/dashboard, not here, so
  // they are not reliable signals of prior initialization.
  const isNew = !existsSync(join(synapseDir, 'SYNAPSE.md'));

  mkdirSync(synapseDir, { recursive: true });

  // Copy instruction templates into .synapse/ (always refresh)
  for (const f of ['SYNAPSE.md', 'SYNAPSE-orchestrator.md', 'SYNAPSE-worker.md']) {
    copyFileSync(join(SYNAPSE_INSTALL_ROOT, 'templates', f), join(synapseDir, f));
  }

  // Unread messages are surfaced by the dashboard poller (see src/dashboard.ts),
  // which nudges idle agents over tmux. The event/guard hooks are CLI subcommands
  // (`synapse hook …`), not copied files.

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
  } else if (update) {
    // Replace the existing Synapse block (from "## Synapse" to the next top-level
    // heading or EOF) with the current block, so updated wording propagates.
    const refreshed = claudeContent.replace(/\n?## Synapse\n[\s\S]*?(?=\n## |$)/, synapseBlock.replace(/\n$/, ''));
    writeFileSync(claudeMd, refreshed, 'utf8');
  }

  // Register the synapse-bus MCP server in .mcp.json (idempotent).
  // This is what exposes the mcp__synapse-bus__* tools to agents in this project.
  const mcpConfigPath = join(projectRoot, '.mcp.json');
  const mcpConfig = existsSync(mcpConfigPath)
    ? JSON.parse(readFileSync(mcpConfigPath, 'utf8'))
    : {};
  const servers = mcpConfig.mcpServers ?? (mcpConfig.mcpServers = {});
  if (!servers['synapse-bus']) {
    servers['synapse-bus'] = {
      type: 'stdio',
      command: 'synapse',
      args: ['mcp'],
      env: {},
    };
    writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf8');
  }

  // Register Synapse hooks in .claude/settings.json (idempotent).
  const claudeDir = join(projectRoot, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  const claudeSettings = join(claudeDir, 'settings.json');
  const existing = existsSync(claudeSettings)
    ? JSON.parse(readFileSync(claudeSettings, 'utf8'))
    : {};
  const hooks = existing.hooks ?? {};

  // Hooks invoke the `synapse` CLI directly — no paths, no copied files. Assumes
  // `synapse` is on PATH (npm link / global install), which the project requires.
  const guardCmd = `synapse hook guard`;
  const eventCmd = (type: string) => `synapse hook event ${type}`;

  // Desired hook registrations: [event, matcher (null = no matcher), command].
  const desired: [string, string | null, string][] = [
    ['PreToolUse',       '.*', guardCmd],          // approval lock (workers only) runs first
    ['PreToolUse',       '.*', eventCmd('PreToolUse')],
    ['PostToolUse',      '',   eventCmd('PostToolUse')],
    ['UserPromptSubmit', null, eventCmd('UserPromptSubmit')],
    ['SubagentStart',    '.*', eventCmd('SubagentStart')],
    ['SubagentStop',     '.*', eventCmd('SubagentStop')],
    ['PreCompact',       null, eventCmd('PreCompact')],
    ['SessionStart',     null, eventCmd('SessionStart')],
    ['SessionEnd',       null, eventCmd('SessionEnd')],
    ['Stop',             null, eventCmd('Stop')],
    ['Notification',     null, eventCmd('Notification')],
  ];

  let changed = false;
  for (const [event, matcher, command] of desired) {
    const list: { matcher?: string; hooks: { type: string; command: string }[] }[] =
      hooks[event] ?? (hooks[event] = []);
    const already = list.some(h => h.hooks?.some(hh => hh.command === command));
    if (!already) {
      const entry: { matcher?: string; hooks: { type: string; command: string }[] } =
        { hooks: [{ type: 'command', command }] };
      if (matcher !== null) entry.matcher = matcher;
      list.push(entry);
      changed = true;
    }
  }
  if (changed) {
    existing.hooks = hooks;
    writeFileSync(claudeSettings, JSON.stringify(existing, null, 2), 'utf8');
  }

  if (!silent) {
    process.stdout.write(isNew
      ? `[Synapse] Initialized at ${projectRoot}\n`
      : update
        ? `[Synapse] Updated templates and config at ${projectRoot}\n`
        : `[Synapse] Already initialized at ${projectRoot}\n`
    );
  }

  return isNew;
}

// Strip unknown flags before Commander sees them (for `synapse run` passthrough)
const SYNAPSE_RUN_KNOWN = new Set(['--role', '--slot', '--task', '--task-file']);
const extraArgs: string[] = [];
if (process.argv[2] === 'run') {
  const clean: string[] = [];
  const argv = process.argv.slice(3);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (SYNAPSE_RUN_KNOWN.has(a)) {
      clean.push(a);
      if (i + 1 < argv.length) clean.push(argv[++i]);
    } else if (a.startsWith('--') || a.startsWith('-')) {
      extraArgs.push(a);
      // If next arg is a value (doesn't start with -), include it too
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        extraArgs.push(argv[++i]);
      }
    } else {
      clean.push(a);
    }
  }
  process.argv = [...process.argv.slice(0, 3), ...clean];
}

const program = new Command();

program
  .name('synapse')
  .description('Synapse CLI: Terminal-First Multi-Agent Orchestrator')
  .version('2.0.0');

program
  .command('init [path]')
  .description('Initialize Synapse in a project directory')
  .option('-u, --update', 're-apply latest templates and refresh CLAUDE.md in an existing project')
  .action((targetPath, options) => {
    synapseInit(resolve(targetPath ?? '.'), false, options.update ?? false);
  });

program
  .command('update [path]')
  .description('Re-apply latest templates and refresh CLAUDE.md in an existing project')
  .action((targetPath) => {
    synapseInit(resolve(targetPath ?? '.'), true);
  });

program
  .command('run')
  .description('Start a Claude session with Synapse system prompt injected')
  .option('--role <role>', 'Agent role: orchestrator or worker', 'orchestrator')
  .option('--slot <slot>', 'Reuse a specific slot, e.g. --slot 0')
  .option('--task <task>', 'Task prompt for worker agents')
  .option('--task-file <file>', 'File containing task prompt for worker agents')
  .action((options) => {
    const role = options.role as string;
    const isWorker = role !== 'orchestrator';
    const systemPrompt = buildSystemPrompt(role);
    const cwd = process.cwd();
    if (options.slot !== undefined) {
      process.env.SYNAPSE_SLOT = String(options.slot);
    }

    // Look up persisted model/effort config for this slot (if any)
    let persistedModel: string | null = null;
    let persistedEffort: string | null = null;
    if (options.slot !== undefined) {
      try {
        const dbPath = process.env.SYNAPSE_DB_PATH ?? join(cwd, '.synapse', 'synapse.db');
        const settingsPath = join(cwd, '.synapse', 'settings.json');
        const projectId: string | null = existsSync(settingsPath)
          ? (JSON.parse(readFileSync(settingsPath, 'utf8')).projectId ?? null)
          : null;
        if (projectId && existsSync(dbPath)) {
          const localDb = openDb(dbPath);
          const row = localDb.prepare<[string], { model: string | null; effort: string | null }>(
            `SELECT model, effort FROM agent_status WHERE agent_id = ?`
          ).get(`${projectId}:${options.slot}`);
          localDb.close();
          persistedModel  = row?.model  ?? null;
          persistedEffort = row?.effort ?? null;
        }
      } catch { /* DB not yet initialized — ignore */ }
    }

    const claudeArgs = ['--append-system-prompt', systemPrompt];
    if (persistedModel)  claudeArgs.push('--model',  persistedModel);
    if (persistedEffort) claudeArgs.push('--effort', persistedEffort);
    if (isWorker) {
      claudeArgs.push('--dangerously-skip-permissions');
      claudeArgs.push('--add-dir', cwd);
      claudeArgs.push('--allowedTools', 'mcp__synapse-bus__read_messages,mcp__synapse-bus__send_message,mcp__synapse-bus__update_status,mcp__synapse-bus__spawn_agent,mcp__synapse-bus__request_approval,mcp__synapse-bus__get_history');
      // '--' ends option parsing so the task prompt isn't treated as a flag
      claudeArgs.push('--');
    }
    const task = options.task
      ?? (options.taskFile ? readFileSync(options.taskFile, 'utf8') : null);
    if (task) {
      claudeArgs.push(task);
    }
    claudeArgs.push(...extraArgs);
    execFileSync('claude', claudeArgs, { stdio: 'inherit' });
  });

program
  .command('hook <kind> [type]')
  .description('Internal: Claude Code hook entrypoint (event|guard). Wired by `synapse init`.')
  .action(async (kind: string, type?: string) => {
    if (kind === 'guard') {
      const { runGuardHook } = await import('./hooks/guard.js');
      await runGuardHook();
    } else if (kind === 'event') {
      const { runEventHook } = await import('./hooks/event.js');
      await runEventHook(type);
    } else {
      process.stderr.write(`Unknown hook kind: ${kind} (expected 'event' or 'guard')\n`);
      process.exit(1);
    }
  });

program
  .command('mcp')
  .description('Start the MCP server (stdio transport, for editor integration)')
  .action(async () => {
    const { startMcpServer } = await import('./mcp-server.js');
    await startMcpServer();
  });

program
  .command('start', { isDefault: true })
  .description('Start the S-Deck dashboard and launch an orchestrator (slot :0) if none is running')
  .option('-p, --port <number>', 'Dashboard port (0 = random free port)', '0')
  .action(async (options) => {
    const cwd = process.cwd();

    // Rename the current tmux window to the project name
    const settingsPath = join(cwd, '.synapse', 'settings.json');
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
    const windowName = settings.name ?? basename(cwd);
    try { execFileSync('tmux', ['rename-window', windowName]); } catch { /* not in tmux */ }

    const isNew = synapseInit(cwd, true);
    if (isNew) process.stderr.write(`[Synapse] Initialized project at ${cwd}\n`);

    // Check if an orchestrator (slot 0) is already live in the DB
    let hasOrchestrator = false;
    try {
      const dbPath = process.env.SYNAPSE_DB_PATH ?? join(cwd, '.synapse', 'synapse.db');
      if (existsSync(dbPath)) {
        const localDb = openDb(dbPath);
        const row = localDb.prepare<[], { agent_id: string }>(
          `SELECT agent_id FROM agent_status WHERE slot = 0 AND ended_at IS NULL LIMIT 1`
        ).get();
        localDb.close();
        hasOrchestrator = row !== undefined;
      }
    } catch { /* DB not yet initialized — no orchestrator */ }

    if (hasOrchestrator) {
      process.stderr.write('[Synapse] Orchestrator (slot :0) already running — starting dashboard only.\n');
    } else {
      // Spawn the orchestrator in a new tmux pane
      const dbPath = process.env.SYNAPSE_DB_PATH ?? join(cwd, '.synapse', 'synapse.db');
      const tmpDir = mkdtempSync(join(tmpdir(), 'synapse-'));
      const launchScript = join(tmpDir, 'launch.sh');
      writeFileSync(launchScript, [
        '#!/bin/sh',
        `export SYNAPSE_DB_PATH=${JSON.stringify(dbPath)}`,
        `synapse run --role orchestrator --slot 0`,
      ].join('\n') + '\n', 'utf8');
      chmodSync(launchScript, 0o755);

      execSync(`tmux new-window -d -c ${JSON.stringify(cwd)} -n ORCH ${JSON.stringify(launchScript)}`);
      process.stderr.write('[Synapse] Launched orchestrator in tmux window "orchestrator" (slot :0).\n');
    }

    // Start the dashboard
    const { db } = await import('./db.js');
    const { startDashboard } = await import('./dashboard.js');

    function shutdown() {
      db.close();
      process.exit(0);
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    const actualPort = await startDashboard(Number(options.port));
    const url = `http://localhost:${actualPort}`;
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${opener} ${url}`);
  });

// ── worktree subcommands ────────────────────────────────────────────────────

/** Return the main (primary) git worktree root — never a secondary worktree path. */
function gitRoot(): string {
  // `git worktree list --porcelain` lists the main worktree first.
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  const firstLine = out.split('\n').find(l => l.startsWith('worktree '));
  if (!firstLine) throw new Error('Could not determine git repo root');
  return firstLine.slice('worktree '.length).trim();
}

/** Return the default branch name tracked by origin/HEAD, falling back to 'main'. */
function defaultBranch(root: string): string {
  try {
    const ref = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: root, encoding: 'utf8',
    }).trim(); // e.g. "refs/remotes/origin/main"
    return ref.replace('refs/remotes/origin/', '');
  } catch {
    return 'main';
  }
}

function worktreePath(root: string, name: string): string {
  return join(root, '.synapse', 'worktrees', name);
}

function branchName(name: string): string {
  return `synapse/${name}`;
}

/** Return true if the worktree at `path` has a dirty working tree. */
function worktreeDirty(wtPath: string): boolean {
  const out = execFileSync('git', ['status', '--porcelain'], {
    cwd: wtPath, encoding: 'utf8',
  });
  return out.trim().length > 0;
}

/** Parse the worker slot from a slug of the form `<role>-<slot>-<task>` or `<role>-<slot>`. */
function slotFromSlug(name: string): number | null {
  // Non-greedy match on the role (may contain hyphens, e.g. "code-reviewer"),
  // then a hyphen-delimited run of digits that is the slot.
  const m = name.match(/^[a-z-]+?-(\d+)(?:-|$)/);
  return m ? parseInt(m[1], 10) : null;
}

/** After a successful merge, attach the resulting HEAD commit to the worker's task. */
function attachMergeCommit(root: string, name: string): void {
  const slot = slotFromSlug(name);
  if (slot === null) {
    process.stderr.write(`[worktree merge] could not parse slot from slug "${name}" — skipping task attach\n`);
    return;
  }
  try {
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const ok = attachCommitToTaskBySlot(slot, headSha);
    if (ok) process.stderr.write(`[worktree merge] attached ${headSha.slice(0, 7)} to slot :${slot} task\n`);
  } catch (e) {
    process.stderr.write(`[worktree merge] task attach failed: ${e}\n`);
  }
}

const worktree = program
  .command('worktree')
  .description('Manage isolated git worktrees for agent tasks');

worktree
  .command('create <name>')
  .description('Create a worktree + branch for a task (branch: synapse/<name>)')
  .action((name: string) => {
    const root = gitRoot();
    const wtPath = worktreePath(root, name);
    const branch = branchName(name);

    if (existsSync(wtPath)) {
      process.stderr.write(`error: worktree path already exists: ${wtPath}\n`);
      process.exit(1);
    }

    // Verify branch doesn't already exist
    try {
      execFileSync('git', ['rev-parse', '--verify', branch], { cwd: root, stdio: 'pipe' });
      process.stderr.write(`error: branch already exists: ${branch}\n`);
      process.exit(1);
    } catch { /* branch absent — good */ }

    mkdirSync(join(root, '.synapse', 'worktrees'), { recursive: true });
    execFileSync('git', ['worktree', 'add', wtPath, '-b', branch, 'HEAD'], {
      cwd: root, stdio: 'inherit',
    });
    process.stdout.write(`${wtPath}\n`);
  });

worktree
  .command('merge <name>')
  .description('Merge synapse/<name> into the default branch, then prune')
  .action((name: string) => {
    const root = gitRoot();
    const wtPath = worktreePath(root, name);
    const branch = branchName(name);
    const main = defaultBranch(root);

    if (!existsSync(wtPath)) {
      process.stderr.write(`error: worktree not found: ${wtPath}\n`);
      process.exit(1);
    }

    if (worktreeDirty(wtPath)) {
      process.stderr.write(`error: uncommitted changes in worktree; commit or stash before merging\n`);
      process.exit(1);
    }

    // Fetch to bring origin up to date (best-effort — don't fail if offline)
    try {
      execFileSync('git', ['fetch', 'origin', main], { cwd: root, stdio: 'pipe' });
    } catch { /* offline or no remote — proceed with local state */ }

    // Try ff-only first
    try {
      execFileSync('git', ['merge', '--ff-only', branch], { cwd: root, stdio: 'pipe' });
      attachMergeCommit(root, name);
      worktreePruneOne(root, name, branch);
      process.stdout.write(`merged: ${name} (ff)\n`);
      return;
    } catch { /* ff not possible — try squash */ }

    // Squash fallback
    try {
      execFileSync('git', ['merge', '--squash', branch], { cwd: root, stdio: 'pipe' });
    } catch (e) {
      process.stderr.write(`error: squash merge failed with conflicts; resolve manually in ${wtPath}\n`);
      // Abort the partial merge state
      try { execFileSync('git', ['merge', '--abort'], { cwd: root, stdio: 'pipe' }); } catch { /* reset might be needed */ }
      try { execFileSync('git', ['reset', '--merge'], { cwd: root, stdio: 'pipe' }); } catch { /* best-effort */ }
      process.exit(1);
    }

    execFileSync('git', ['commit', '-m', `synapse worktree: ${name}`], {
      cwd: root, stdio: 'inherit',
    });

    attachMergeCommit(root, name);
    worktreePruneOne(root, name, branch);
    process.stdout.write(`merged: ${name} (squash)\n`);
  });

worktree
  .command('prune [name]')
  .description('Remove worktree dir and branch. Use --all to prune every synapse worktree.')
  .option('--all', 'prune all worktrees under .synapse/worktrees/')
  .action((name: string | undefined, opts: { all?: boolean }) => {
    const root = gitRoot();
    if (opts.all) {
      const wtRoot = join(root, '.synapse', 'worktrees');
      if (!existsSync(wtRoot)) {
        process.stdout.write('nothing to prune\n');
        return;
      }
      const entries = readdirSync(wtRoot);
      if (!entries.length) {
        process.stdout.write('nothing to prune\n');
        return;
      }
      for (const entry of entries) {
        worktreePruneOne(root, entry, branchName(entry));
      }
    } else {
      if (!name) {
        process.stderr.write('error: provide a name or --all\n');
        process.exit(1);
      }
      worktreePruneOne(root, name, branchName(name));
    }
  });

function worktreePruneOne(root: string, name: string, branch: string): void {
  const wtPath = worktreePath(root, name);
  // Remove the worktree (idempotent — ignore errors if already gone)
  try {
    execFileSync('git', ['worktree', 'remove', '--force', wtPath], {
      cwd: root, stdio: 'pipe',
    });
  } catch { /* already removed or not a registered worktree */ }

  // Delete the branch if it still exists
  try {
    execFileSync('git', ['branch', '-D', branch], { cwd: root, stdio: 'pipe' });
  } catch { /* branch already gone */ }

  process.stdout.write(`pruned: ${name}\n`);
}

program
  .command('eval')
  .description('Extract and evaluate agent trajectory cases')
  .option('--critic', 'Run critic agent on failed trajectories to propose rule patches')
  .option('--gate', 'Run validation gate on all critic patches')
  .option('--limit <n>', 'Number of most recent completed tasks to evaluate', '20')
  .action(async (options) => {
    const { extractCases } = await import('./eval/extract.js');
    const { evaluateCases } = await import('./eval/evaluator.js');
    const { writeFileSync, readdirSync } = await import('fs');
    const { join } = await import('path');
    const dbPath = process.env.SYNAPSE_DB_PATH ?? join(process.cwd(), '.synapse', 'synapse.db');
    const casesDir = join(process.cwd(), 'tests', 'cases');
    const reportPath = join(process.cwd(), 'tests', 'eval_report.json');
    const limit = parseInt(options.limit, 10);

    process.stdout.write(`Extracting last ${limit} completed trajectory cases...\n`);
    extractCases(dbPath, casesDir, limit);

    process.stdout.write('\nEvaluating trajectories...\n');
    const results = evaluateCases(casesDir);
    const passed = results.filter((r: any) => r.pass);
    const failed = results.filter((r: any) => !r.pass);

    process.stdout.write(`\n=== EVAL REPORT ===\nPASS: ${passed.length}/${results.length}\n`);
    failed.forEach((r: any) => {
      process.stdout.write(`  FAIL [${r.label.toUpperCase()}] #${r.id} ${r.title.slice(0, 45)}\n`);
      r.failures.forEach((f: string) => process.stdout.write(`    - ${f}\n`));
    });
    passed.forEach((r: any) => {
      process.stdout.write(`  PASS [${r.label.toUpperCase()}] #${r.id} ${r.title.slice(0, 45)}\n`);
    });

    writeFileSync(reportPath, JSON.stringify(results, null, 2));
    process.stdout.write(`\nWrote ${results.length} results to ${reportPath}\n`);

    if (options.critic) {
      const { runCritic } = await import('./eval/critic.js');
      const rulesFile = join(process.cwd(), 'templates', 'SYNAPSE-orchestrator.md');
      const patchDir = join(process.cwd(), 'tests', 'patches');
      process.stdout.write(`\nRunning critic on ${failed.length} failed trajectories...\n`);
      for (const r of failed) {
        const caseFile = join(casesDir, `task_${r.id}_${r.label}.json`);
        process.stdout.write(`  Critic analyzing #${r.id}...\n`);
        const patch = await runCritic(caseFile, rulesFile, patchDir);
        process.stdout.write(`  → ${patch.slice(0, 100).replace(/\n/g, ' ')}...\n`);
      }
      process.stdout.write(`\nPatches written to tests/patches/\n`);
    }

    if (options.gate) {
      const { runGate } = await import('./eval/gate.js');
      const patchDir = join(process.cwd(), 'tests', 'patches');
      const gateDir = join(process.cwd(), 'tests', 'gate_results');
      const rulesFile = join(process.cwd(), 'templates', 'SYNAPSE-orchestrator.md');
      const patches = readdirSync(patchDir).filter((f: string) => f.endsWith('.md'));
      process.stdout.write(`\nRunning validation gate on ${patches.length} patches...\n`);
      for (const p of patches) {
        const result = await runGate(join(patchDir, p), casesDir, rulesFile, gateDir);
        process.stdout.write(`  ${p}: regression=${result.regression_pass} coverage=${result.deploy_recommended ? 'ADEQUATE' : 'INADEQUATE'} → ${result.deploy_recommended ? 'DEPLOY ✓' : 'HOLD ✗'}\n`);
      }
    }
  });

program.parse(process.argv);
