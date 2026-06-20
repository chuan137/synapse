import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';

function settingsPath(cwd: string): string {
  return join(cwd, '.synapse', 'settings.json');
}

function readSettings(cwd: string): any {
  const p = settingsPath(cwd);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
}

function writeSettings(cwd: string, settings: any): void {
  writeFileSync(settingsPath(cwd), JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

// Avoid well-known/registered ports — stick to a wide ephemeral-ish band.
function pickRandomPort(): number {
  return 20000 + Math.floor(Math.random() * 40000);
}

let dashboardUrlPrinted = false;
function printDashboardUrl(port: number): void {
  if (dashboardUrlPrinted) return;
  dashboardUrlPrinted = true;
  process.stderr.write(`[headroom] dashboard: http://localhost:${port}/dashboard\n`);
}

/**
 * Read `headroom.port` from settings.json, minting and persisting a random one the
 * first time headroom is enabled without an explicit port. Persisting (instead of
 * re-randomizing per process) is what lets every agent in the swarm — orchestrator
 * and every worker, each its own `synapse run` process reading the same file — land
 * on the same proxy, while a random pick (instead of the fixed default 8787) avoids
 * collisions with another Synapse project's proxy running on the same machine.
 *
 * Returns null if headroom isn't enabled. Safe to call repeatedly — only writes once.
 */
export function ensureHeadroomPort(cwd: string): number | null {
  const settings = readSettings(cwd);
  const h = settings.headroom ?? {};
  if (h.enabled !== true) return null;

  if (typeof h.port === 'number') return h.port;

  const port = pickRandomPort();
  settings.headroom = { ...h, port };
  writeSettings(cwd, settings);
  process.stderr.write(`[Synapse] headroom proxy port assigned: ${port} (saved to .synapse/settings.json)\n`);
  return port;
}

async function isProxyHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealthy(port: number, attempts = 20, intervalMs = 250): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await isProxyHealthy(port)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function spawnProxy(port: number, logFile: string, extraEnv: Record<string, string>): void {
  const child = spawn('headroom', ['proxy', '--port', String(port), '--log-file', logFile], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...extraEnv },
  });
  // spawn() reports a missing binary (ENOENT) asynchronously via 'error', not as a throw —
  // attach the handler before unref() so the message still surfaces.
  child.on('error', (e) => {
    process.stderr.write(
      `[Synapse] headroom proxy failed to start (${e.message}). ` +
      `Install with: pip install "headroom-ai[proxy]"\n`
    );
  });
  child.unref();
}

/**
 * Ensure a single shared `headroom proxy` is running for this project, so every
 * Claude Code process Synapse spawns — orchestrator and every worker, all launched
 * via `synapse run` — routes through the same compression/memory store.
 *
 * One proxy per project (not per-agent): wrapping each spawned agent individually
 * would give each its own CCR store and lose the cross-agent dedup benefit when
 * multiple workers read overlapping files/logs in the same repo.
 *
 * Opt-in via `.synapse/settings.json`: { "headroom": { "enabled": true } }. The port
 * is auto-assigned (see ensureHeadroomPort) — don't hardcode one.
 * Best-effort — any failure (binary missing, proxy won't boot) logs a warning and
 * returns null so agent startup is never blocked by this.
 */
export async function ensureHeadroomProxy(cwd: string): Promise<{ baseUrl: string } | null> {
  const port = ensureHeadroomPort(cwd);
  if (port === null) return null;

  const baseUrl = `http://127.0.0.1:${port}`;

  if (await isProxyHealthy(port)) {
    printDashboardUrl(port);
    return { baseUrl };
  }

  const settings = readSettings(cwd);
  const extraEnv: Record<string, string> = settings.headroom?.env ?? {};
  const logFile = join(cwd, '.synapse', 'headroom.jsonl');
  spawnProxy(port, logFile, extraEnv);

  const healthy = await waitForHealthy(port);
  if (!healthy) {
    process.stderr.write(
      `[Synapse] headroom proxy did not become healthy on port ${port} within 5s. Continuing without compression.\n`
    );
    return null;
  }

  process.stderr.write(`[Synapse] headroom proxy running at ${baseUrl} (shared across all agents).\n`);
  printDashboardUrl(port);
  return { baseUrl };
}
