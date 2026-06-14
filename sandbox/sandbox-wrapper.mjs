#!/usr/bin/env node
/**
 * sandbox-wrapper.mjs
 *
 * PoC wrapper for running claude/codex inside a Docker container with
 * pause-on-idle / unpause-on-demand lifecycle.
 *
 * Usage:
 *   SANDBOX_CONTAINER=my-sandbox node sandbox/sandbox-wrapper.mjs
 *   Then type prompts interactively, or pipe them in.
 */

import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execAsync = promisify(execFile);

// ── Config ────────────────────────────────────────────────────────────────────

const CONTAINER   = process.env.SANDBOX_CONTAINER ?? 'sandbox-agent';
const SESSION     = process.env.TMUX_SESSION       ?? 'main';
const OUTPUT_LOG  = '/tmp/tty-output.log';

// Prompt patterns for claude and codex (covers ANSI-wrapped variants too)
const PROMPT_RE = /❯\s*$|>\s*$|\$\s*$/m;

const SETTLE_MS        = 200;   // silence window after prompt detected
const TURN_TIMEOUT_MS  = 120_000;
const UNPAUSE_WAIT_MS  = 300;   // give container time to resume before injecting

// ── Docker helpers ────────────────────────────────────────────────────────────

async function dockerPause() {
  try { await execAsync('docker', ['pause', CONTAINER]); } catch { /* already paused */ }
}

async function dockerUnpause() {
  try { await execAsync('docker', ['unpause', CONTAINER]); } catch { /* already running */ }
}

async function dockerExec(...args) {
  return execAsync('docker', ['exec', CONTAINER, ...args]);
}

// ── ANSI stripper (state-machine) ─────────────────────────────────────────────

function stripAnsi(str) {
  return str
    // CSI sequences: ESC [ ... final-byte (includes private params like >0q, ?2026$p)
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '')
    // DCS sequences: ESC P ... ST
    .replace(/\x1bP[^\x1b]*(\x1b\\|\x9c)/g, '')
    // OSC sequences: ESC ] ... ST or BEL
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    // APC sequences: ESC _ ... ST
    .replace(/\x1b_[^\x1b]*\x1b\\/g, '')
    // PM sequences: ESC ^ ... ST
    .replace(/\x1b\^[^\x1b]*\x1b\\/g, '')
    // SOS sequences: ESC X ... ST
    .replace(/\x1bX[^\x1b]*\x1b\\/g, '')
    // SS2/SS3: ESC N/O + single char
    .replace(/\x1b[NO]./g, '')
    // RIS and other two-char ESC sequences
    .replace(/\x1b[^\[PNOQ\]_^X]/g, '')
    // Remaining bare ESC
    .replace(/\x1b/g, '')
    // C1 control codes (0x80–0x9f)
    .replace(/[\x80-\x9f]/g, '');
}

// ── Output tailer ─────────────────────────────────────────────────────────────

/**
 * Tails OUTPUT_LOG inside the container via `docker exec tail -f`.
 * Calls onChunk(cleanedText) for every chunk, resolves when promptRe matches
 * after SETTLE_MS of silence, or rejects on timeout.
 */
function waitForPrompt(onChunk) {
  return new Promise((resolve, reject) => {
    const tail = spawn('docker', ['exec', CONTAINER, 'tail', '-f', '-n', '0', OUTPUT_LOG]);

    let settled = null;
    let timer   = null;

    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(settled);
      tail.kill('SIGTERM');
    };

    // Hard timeout
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Turn timeout after ${TURN_TIMEOUT_MS}ms`));
    }, TURN_TIMEOUT_MS);

    tail.stdout.setEncoding('utf8');
    tail.stdout.on('data', (raw) => {
      const text = stripAnsi(raw);
      onChunk(text);

      if (PROMPT_RE.test(text)) {
        // Reset settle timer on every prompt-matching chunk
        clearTimeout(settled);
        settled = setTimeout(() => {
          cleanup();
          resolve();
        }, SETTLE_MS);
      }
    });

    tail.stderr.on('data', () => {}); // suppress
    tail.on('exit', (code) => {
      if (code !== null && code !== 0 && code !== 143 /* SIGTERM */) {
        cleanup();
        reject(new Error(`tail exited with code ${code}`));
      }
    });
  });
}

// ── Concurrency lock ──────────────────────────────────────────────────────────

let busy = false;
const queue = [];

function enqueue(input) {
  return new Promise((resolve, reject) => {
    queue.push({ input, resolve, reject });
    drain();
  });
}

async function drain() {
  if (busy || queue.length === 0) return;
  busy = true;
  const { input, resolve, reject } = queue.shift();
  try {
    resolve(await runTurn(input));
  } catch (err) {
    reject(err);
  } finally {
    busy = false;
    drain();
  }
}

// ── Core turn logic ───────────────────────────────────────────────────────────

async function runTurn(input) {
  process.stderr.write(`[wrapper] unpause → inject: ${JSON.stringify(input)}\n`);

  await dockerUnpause();
  await new Promise(r => setTimeout(r, UNPAUSE_WAIT_MS));

  // Inject input into tmux
  // Use send-keys with the literal string; for long inputs write to a temp file
  if (input.length > 400) {
    const tmpFile = `/tmp/input-${Date.now()}.txt`;
    await dockerExec('bash', '-c', `printf '%s' ${JSON.stringify(input)} > ${tmpFile}`);
    await dockerExec('tmux', 'load-buffer', '-t', SESSION, tmpFile);
    await dockerExec('tmux', 'paste-buffer', '-t', SESSION);
    await dockerExec('tmux', 'send-keys', '-t', SESSION, '', 'Enter');
    await dockerExec('rm', '-f', tmpFile);
  } else {
    await dockerExec('tmux', 'send-keys', '-t', SESSION, input, 'Enter');
  }

  // Collect output until prompt detected
  let output = '';
  await waitForPrompt((chunk) => {
    process.stdout.write(chunk);
    output += chunk;
  });

  process.stderr.write(`[wrapper] prompt detected → pausing container\n`);
  await dockerPause();

  return output;
}

// ── Interactive REPL ──────────────────────────────────────────────────────────

async function main() {
  process.stderr.write(`[wrapper] container=${CONTAINER} session=${SESSION}\n`);
  process.stderr.write(`[wrapper] waiting for initial prompt...\n`);

  // Wait for the CLI's initial prompt before accepting input
  await waitForPrompt((chunk) => process.stdout.write(chunk));
  await dockerPause();

  process.stderr.write(`[wrapper] ready. Type prompts below (Ctrl-D to exit).\n\n`);

  const rl = createInterface({ input: process.stdin, terminal: false });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      await enqueue(line);
    } catch (err) {
      process.stderr.write(`[wrapper] error: ${err.message}\n`);
    }
  }

  process.stderr.write(`[wrapper] stdin closed, pausing container.\n`);
  await dockerPause();
}

main().catch((err) => {
  process.stderr.write(`[wrapper] fatal: ${err.message}\n`);
  process.exit(1);
});
