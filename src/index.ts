#!/usr/bin/env node
import { Command } from 'commander';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { exec, execFileSync, execSync, spawn } from 'child_process';
import { openDb, attachCommitToTaskBySlot, resetMetricCount } from './db.js';
import { buildSystemPrompt } from './system-prompt.js';
import { parseRoleFile } from './roles.js';

/** List all available named roles from templates/roles/, returning their metadata. */
function listAvailableRoles(templatesDir: string): { role: string; description: string; capabilities: string[] }[] {
  const rolesDir = join(templatesDir, 'roles');
  if (!existsSync(rolesDir)) return [];
  return readdirSync(rolesDir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
      const content = readFileSync(join(rolesDir, f), 'utf8');
      const parsed = parseRoleFile(content);
      if (!parsed) return null;
      return { role: parsed.name, description: parsed.description, capabilities: parsed.capabilities };
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
  for (const f of ['SYNAPSE.md', 'SYNAPSE-orchestrator.md', 'SYNAPSE-worker.md',
                    'boot-orchestrator.md', 'boot-worker-restart.md']) {
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
    synapseInit(resolve(targetPath ?? '.'), false, true);
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
    const bootOrchPath = existsSync(join(cwd, '.synapse', 'boot-orchestrator.md'))
      ? join(cwd, '.synapse', 'boot-orchestrator.md')
      : join(SYNAPSE_INSTALL_ROOT, 'templates', 'boot-orchestrator.md');
    const orchBootPrompt = !isWorker
      ? readFileSync(bootOrchPath, 'utf8').trim()
      : null;
    const task = options.task
      ?? (options.taskFile ? readFileSync(options.taskFile, 'utf8') : null)
      ?? orchBootPrompt;
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
  .option('--debug', 'Show verbose debug logs (HTTP requests, internal events)')
  .action(async (options) => {
    if (options.debug) process.env.SYNAPSE_DEBUG = '1';
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
    const taskId = attachCommitToTaskBySlot(slot, headSha);
    if (taskId !== null) {
      process.stderr.write(`[worktree merge] attached ${headSha.slice(0, 7)} to slot :${slot} task\n`);
      const indexJs = join(dirname(fileURLToPath(import.meta.url)), 'index.js');
      const child = spawn(process.execPath, [indexJs, 'eval', '--task-id', String(taskId)], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
      child.unref();
    }
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
  .option('--calibrate', 'Compute per-role p90 thresholds from good cases and write src/eval/thresholds.json')
  .option('--percentile <n>', 'Percentile for --calibrate threshold computation', '90')
  .option('--regenerate-all', 'Re-extract every task that has an existing case file (upgrades v1 to v2)')
  .option('--limit <n>', 'Number of most recent completed tasks to evaluate', '20')
  .option('--task-id <n>', 'Evaluate a single task by ID and write results to eval_results table')
  .action(async (options) => {
    const { extractCases } = await import('./eval/extract.js');
    const { evaluateCases } = await import('./eval/evaluator.js');
    const { writeFileSync, readdirSync } = await import('fs');
    const { join } = await import('path');
    const dbPath = process.env.SYNAPSE_DB_PATH ?? join(process.cwd(), '.synapse', 'synapse.db');
    const casesDir = join(process.cwd(), 'tests', 'cases');
    const reportPath = join(process.cwd(), 'tests', 'eval_report.json');
    const limit = parseInt(options.limit, 10);

    if (options.calibrate) {
      const { readdirSync: readDir, readFileSync: readF, writeFileSync: writeF, existsSync: checkExists } = await import('fs');
      const { fileURLToPath: fu } = await import('url');
      const { dirname: dn } = await import('path');
      const pct = Math.min(100, Math.max(1, parseInt(options.percentile ?? '90', 10))) / 100;
      const MIN_SAMPLES = 3;

      if (!checkExists(casesDir)) {
        process.stderr.write(`error: cases directory not found: ${casesDir}\n`);
        process.exit(1);
      }

      const goodFiles = readDir(casesDir).filter((f: string) => f.endsWith('_good.json'));
      if (goodFiles.length === 0) {
        process.stderr.write(`No *_good.json cases found in ${casesDir}\n`);
        process.exit(1);
      }

      const byRole: Record<string, {
        toolCalls: number[]; durationMs: number[]; activeDurationMs: number[];
        hasCommit: boolean[]; blockedEvents: number[]; errorRates: number[];
        wallClockMs: number[];
      }> = {};

      for (const f of goodFiles) {
        const c = JSON.parse(readF(join(casesDir, f), 'utf8')) as any;
        if (c.label !== 'good') continue;

        // v2 path: per-agent stats
        if (c.agents) {
          for (const agent of Object.values(c.agents) as any[]) {
            const role: string = agent.role ?? '_default';
            if (!byRole[role]) byRole[role] = { toolCalls: [], durationMs: [], activeDurationMs: [], hasCommit: [], blockedEvents: [], errorRates: [], wallClockMs: [] };
            const totalCalls: number = Object.values(agent.tools as Record<string, any>).reduce((s: number, t: any) => s + t.calls, 0);
            byRole[role].toolCalls.push(totalCalls);
            byRole[role].activeDurationMs.push(agent.active_duration_ms ?? 0);
            byRole[role].blockedEvents.push(agent.blocked_events?.length ?? 0);
            for (const ts of Object.values(agent.tools as Record<string, any>) as any[]) {
              if (ts.calls > 0) byRole[role].errorRates.push(ts.error_rate);
            }
          }
          // Wall-clock collected at task level, attributed to primary agent's role
          const primaryRole = Object.values(c.agents as Record<string, any>)[0]?.role ?? '_default';
          if (c.total_duration_ms != null) byRole[primaryRole]?.wallClockMs.push(c.total_duration_ms);
          byRole[primaryRole]?.hasCommit.push(!!c.commit_sha);
        } else {
          // v1 fallback
          const key = '_default';
          if (!byRole[key]) byRole[key] = { toolCalls: [], durationMs: [], activeDurationMs: [], hasCommit: [], blockedEvents: [], errorRates: [], wallClockMs: [] };
          byRole[key].toolCalls.push(c.metrics?.tool_calls ?? 0);
          if (c.metrics?.duration_ms != null) {
            byRole[key].durationMs.push(c.metrics.duration_ms);
            byRole[key].wallClockMs.push(c.metrics.duration_ms);
          }
          byRole[key].hasCommit.push(!!c.metrics?.has_commit);
          byRole[key].blockedEvents.push(0);
        }
      }

      function pctile(arr: number[], p: number): number {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a: number, b: number) => a - b);
        return sorted[Math.floor(sorted.length * p)];
      }

      const sampleSize: Record<string, number> = {};
      const byRoleThresholds: Record<string, any> = {};
      const skipped: string[] = [];

      for (const [role, stats] of Object.entries(byRole)) {
        sampleSize[role] = stats.toolCalls.length;
        if (stats.toolCalls.length < MIN_SAMPLES) {
          process.stdout.write(`  WARNING: role '${role}' has only ${stats.toolCalls.length} sample(s) — skipping (need ≥ ${MIN_SAMPLES})\n`);
          skipped.push(role);
          continue;
        }
        const srcArr = stats.activeDurationMs.length > 0 ? stats.activeDurationMs : stats.durationMs;
        const commitRate = stats.hasCommit.filter(Boolean).length / Math.max(1, stats.hasCommit.length);
        const t: Record<string, any> = {
          tool_calls_p90: Math.ceil(pctile(stats.toolCalls, pct)),
          duration_ms_p90: Math.ceil(pctile(srcArr, pct)),
          error_rate_max: Math.min(1, parseFloat((pctile(stats.errorRates, pct) + 0.05).toFixed(2))),
        };
        if (commitRate >= 0.8) t.has_commit = true;
        // wall_clock_ms_p90: collected for future hard-gate decision; not enforced yet
        if (stats.wallClockMs.length >= MIN_SAMPLES) {
          t.wall_clock_ms_p90 = Math.ceil(pctile(stats.wallClockMs, pct));
        }
        byRoleThresholds[role] = t;
      }

      const thresholdsFile = {
        calibrated_at: new Date().toISOString(),
        sample_size: sampleSize,
        by_role: byRoleThresholds,
        task_level: { traceability_score_max: 1 },
      };

      // Write to src/eval/thresholds.json (next to evaluator.ts / schema-v2.ts)
      const evalSrcDir = join(process.cwd(), 'src', 'eval');
      const outPath = join(evalSrcDir, 'thresholds.json');
      writeF(outPath, JSON.stringify(thresholdsFile, null, 2));
      process.stdout.write(`Calibrated from ${goodFiles.length} good cases → ${outPath}\n`);
      for (const [role, t] of Object.entries(byRoleThresholds)) {
        process.stdout.write(`  ${role} (n=${sampleSize[role]}): ${JSON.stringify(t)}\n`);
      }
      if (skipped.length > 0) {
        process.stdout.write(`  Skipped (too few samples): ${skipped.join(', ')}\n`);
      }
      process.exit(0);
    }

    if (options.regenerateAll) {
      const { regenerateAllCases } = await import('./eval/extract.js');
      process.stdout.write(`Regenerating all case files in ${casesDir}...\n`);
      const count = regenerateAllCases(dbPath, casesDir);
      process.stdout.write(`Regenerated ${count} case files.\n`);
      process.exit(0);
    }

    if (options.taskId !== undefined) {
      // Single-task mode: fetch, score, persist, print
      const taskId = parseInt(options.taskId, 10);
      const { writeEvalResults, checkAndResetMetricThreshold } = await import('./db.js');
      process.stdout.write(`Evaluating task #${taskId}...\n`);
      const singleCases = extractCases(dbPath, casesDir, 1, taskId);
      if (singleCases.length === 0) {
        process.stdout.write(`Task #${taskId} not found in completed tasks.\n`);
        process.exit(0);
      }
      const allResults = evaluateCases(casesDir);
      const result = allResults.find((r: any) => r.id === taskId);
      if (!result) {
        process.stdout.write(`Task #${taskId} could not be evaluated.\n`);
        process.exit(0);
      }
      const primaryAgentId = (result as any).task?.agent_id ?? '';
      const evalRows = [
        { metric: 'traceability', passed: !result.failures.some((f: any) => f.metric === 'traceability_score'), value: result.metrics.traceability_score },
        { metric: 'tool_calls',   passed: !result.failures.some((f: any) => f.metric === 'tool_calls'),         value: result.metrics.tool_calls },
        { metric: 'duration',     passed: !result.failures.some((f: any) => f.metric.includes('duration')),     value: result.metrics.duration_ms },
        { metric: 'has_commit',   passed: !result.failures.some((f: any) => f.metric === 'has_commit'),         value: null },
      ];
      writeEvalResults(taskId, evalRows, true, (result as any).role ?? null, primaryAgentId);
      for (const r of evalRows) {
        if (!r.passed) {
          const triggered = checkAndResetMetricThreshold(r.metric);
          if (triggered) {
            process.stdout.write(`  ⚠ threshold reached for metric: ${r.metric} — click "Generate proposal" in S-Deck Eval tab\n`);
          }
        }
      }
      process.stdout.write(`Task #${taskId}: ${result.pass ? 'PASS' : 'FAIL'}\n`);
      if (!result.pass) {
        result.failures.forEach((f: any) => process.stdout.write(`  - [${f.role}/${f.agent_id}] ${f.metric}=${f.value} (max ${f.threshold})\n`));
      }
      process.exit(0);
    }

    process.stdout.write(`Extracting last ${limit} completed trajectory cases...\n`);
    // Clear stale case files so evaluateCases only scores this run's tasks
    const { readdirSync: readDir, rmSync } = await import('fs');
    if (existsSync(casesDir)) {
      for (const f of readDir(casesDir).filter((f: string) => f.endsWith('.json'))) {
        rmSync(join(casesDir, f));
      }
    }
    extractCases(dbPath, casesDir, limit);

    process.stdout.write('\nEvaluating trajectories...\n');
    const results = evaluateCases(casesDir);
    const passed = results.filter((r: any) => r.pass);
    const failed = results.filter((r: any) => !r.pass);

    process.stdout.write(`\n=== EVAL REPORT ===\nPASS: ${passed.length}/${results.length}\n`);
    failed.forEach((r: any) => {
      process.stdout.write(`  FAIL [${r.label.toUpperCase()}] #${r.id} ${r.title.slice(0, 45)}\n`);
      r.failures.forEach((f: any) => process.stdout.write(`    - [${f.role}/${f.agent_id}] ${f.metric}=${f.value} (max ${f.threshold})\n`));
    });
    passed.forEach((r: any) => {
      process.stdout.write(`  PASS [${r.label.toUpperCase()}] #${r.id} ${r.title.slice(0, 45)}\n`);
    });

    writeFileSync(reportPath, JSON.stringify(results, null, 2));
    process.stdout.write(`\nWrote ${results.length} results to ${reportPath}\n`);

    // Also persist results to eval_results DB table
    const { writeEvalResults } = await import('./db.js');
    for (const r of results) {
      const primaryAgentId = (r as any).task?.agent_id ?? '';
      writeEvalResults(r.id, [
        { metric: 'traceability', passed: !r.failures.some((f: any) => f.metric === 'traceability_score'), value: r.metrics.traceability_score },
        { metric: 'tool_calls',   passed: !r.failures.some((f: any) => f.metric === 'tool_calls'),         value: r.metrics.tool_calls },
        { metric: 'duration',     passed: !r.failures.some((f: any) => f.metric.includes('duration')),     value: r.metrics.duration_ms },
        { metric: 'has_commit',   passed: !r.failures.some((f: any) => f.metric === 'has_commit'),         value: null },
      ], false, (r as any).role ?? null, primaryAgentId);
    }
    process.stdout.write(`Persisted ${results.length} eval results to DB\n`);

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

program
  .command('eval-window')
  .description('Aggregate eval metrics across a time window and produce a markdown report')
  .option('--since <duration>', 'Time window duration (e.g. 7d, 24h, 2w)', '7d')
  .option('--from <date>', 'Start date ISO or epoch ms')
  .option('--to <date>', 'End date ISO or epoch ms (default: now)')
  .option('--role <role>', 'Filter to one role')
  .option('--output <path>', 'Output file path (default: auto-named in .synapse/reports/)')
  .action(async (options) => {
    const { generateWindowReport } = await import('./eval/window.js');
    const { mkdirSync, writeFileSync } = await import('fs');
    const { join } = await import('path');

    const dbPath = process.env.SYNAPSE_DB_PATH ?? join(process.cwd(), '.synapse', 'synapse.db');

    const opts: any = {};
    if (options.since) opts.since = options.since;
    if (options.from) opts.from = isNaN(Number(options.from)) ? new Date(options.from).getTime() : Number(options.from);
    if (options.to)   opts.to   = isNaN(Number(options.to))   ? new Date(options.to).getTime()   : Number(options.to);
    if (options.role) opts.role = options.role;

    let report: string;
    try {
      report = generateWindowReport(dbPath, opts);
    } catch (err: any) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exit(1);
    }

    process.stdout.write(report);

    const outPath = options.output ?? (() => {
      const slug = options.since ?? 'custom';
      const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
      const reportsDir = join(process.cwd(), '.synapse', 'reports');
      mkdirSync(reportsDir, { recursive: true });
      return join(reportsDir, `${ts}-window-${slug}.md`);
    })();
    writeFileSync(outPath, report);
    process.stderr.write(`\nReport written to ${outPath}\n`);
  });

program
  .command('eval-apply <proposal-file>')
  .description('Apply a gate-approved proposal patch to the target rule file, commit, and reset the failure counter')
  .action((proposalFile: string) => {
    const proposalPath = resolve(proposalFile);
    if (!existsSync(proposalPath)) {
      process.stderr.write(`error: proposal file not found: ${proposalPath}\n`);
      process.exit(1);
    }

    let content = readFileSync(proposalPath, 'utf8');
    const targetMatch = content.match(/^Target-file:\s*(.+)$/im);
    const changeMatch = content.match(/^##\s*Proposed rule change\s*\n([\s\S]*?)(?=\n##|$)/im);
    const metricMatch = basename(proposalPath).match(/^\d+-(\w+)\.md$/);

    if (!targetMatch) {
      process.stderr.write(`error: no Target-file field found in proposal\n`);
      process.exit(1);
    }

    const targetFile = join(process.cwd(), targetMatch[1].trim());
    const proposedChange = changeMatch ? changeMatch[1].trim() : '';
    const metric = metricMatch ? metricMatch[1] : '';

    if (proposedChange && existsSync(targetFile)) {
      const existing = readFileSync(targetFile, 'utf8');
      writeFileSync(targetFile, existing.trimEnd() + '\n\n' + proposedChange + '\n', 'utf8');
      process.stdout.write(`Appended proposed change to ${targetMatch[1].trim()}\n`);
    } else if (!existsSync(targetFile)) {
      process.stderr.write(`warning: target file not found: ${targetFile}\n`);
    }

    try {
      execSync('synapse update .', { cwd: process.cwd(), stdio: 'pipe' });
      process.stdout.write(`Ran synapse update .\n`);
    } catch { /* best-effort */ }

    const commitMsg = metric
      ? `fix(${metric}): apply rule patch from proposal ${basename(proposalPath)}`
      : `deploy proposal: ${basename(proposalPath)}`;
    try {
      execSync(`git add "${targetFile}" && git commit -m ${JSON.stringify(commitMsg)}`, {
        cwd: process.cwd(), stdio: 'pipe',
      });
      process.stdout.write(`Committed: ${commitMsg}\n`);
    } catch { process.stdout.write(`Nothing to commit (target file unchanged or already staged)\n`); }

    if (metric) {
      resetMetricCount(metric);
      process.stdout.write(`Reset failure counter for metric: ${metric}\n`);
    }

    content = content.replace(/^Status:\s*.+$/im, 'Status: deployed');
    writeFileSync(proposalPath, content, 'utf8');
    process.stdout.write(`Marked proposal as deployed: ${basename(proposalPath)}\n`);
  });

program.parse(process.argv);
