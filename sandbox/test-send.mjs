#!/usr/bin/env node
/**
 * Quick test: send one message to the sandbox container and print the response.
 *
 * Usage:
 *   node sandbox/test-send.mjs "your prompt here"
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';

const execAsync = promisify(execFile);

const CONTAINER  = process.env.SANDBOX_CONTAINER ?? 'sandbox-agent';
const SESSION    = process.env.TMUX_SESSION       ?? 'main';
const OUTPUT_LOG = '/tmp/tty-output.log';
const SETTLE_MS  = 300;
const TIMEOUT_MS = 120_000;

const prompt = process.argv.slice(2).join(' ') || 'Say hello in one sentence.';

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '')
    .replace(/\x1bP[^\x1b]*(\x1b\\|\x9c)/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b_[^\x1b]*\x1b\\/g, '')
    .replace(/\x1b\^[^\x1b]*\x1b\\/g, '')
    .replace(/\x1bX[^\x1b]*\x1b\\/g, '')
    .replace(/\x1b[NO]./g, '')
    .replace(/\x1b[^\[PNOQ\]_^X]/g, '')
    .replace(/\x1b/g, '')
    .replace(/[\x80-\x9f]/g, '');
}

const PROMPT_RE = /❯\s*$|>\s*$/m;

async function dockerUnpause() {
  try { await execAsync('docker', ['unpause', CONTAINER]); } catch { /* already running */ }
}

async function dockerPause() {
  try { await execAsync('docker', ['pause', CONTAINER]); } catch { /* already paused */ }
}

function waitForPrompt(onChunk) {
  return new Promise((resolve, reject) => {
    const tail = spawn('docker', ['exec', CONTAINER, 'tail', '-f', '-n', '0', OUTPUT_LOG]);
    let settled = null;
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, TIMEOUT_MS);

    const cleanup = () => { clearTimeout(timer); clearTimeout(settled); tail.kill('SIGTERM'); };

    tail.stdout.setEncoding('utf8');
    tail.stdout.on('data', (raw) => {
      const text = stripAnsi(raw);
      if (text.trim()) onChunk(text);
      if (PROMPT_RE.test(text)) {
        clearTimeout(settled);
        settled = setTimeout(() => { cleanup(); resolve(); }, SETTLE_MS);
      }
    });
    tail.stderr.on('data', () => {});
    tail.on('exit', (code) => {
      if (code !== null && code !== 0 && code !== 143) { cleanup(); reject(new Error(`tail exited ${code}`)); }
    });
  });
}

async function main() {
  process.stderr.write(`[test] container=${CONTAINER}\n`);
  process.stderr.write(`[test] prompt: ${prompt}\n\n`);

  await dockerUnpause();
  await new Promise(r => setTimeout(r, 300));

  // Inject prompt
  await execAsync('docker', ['exec', CONTAINER, 'tmux', 'send-keys', '-t', SESSION, prompt, 'Enter']);

  // Collect response
  process.stdout.write('--- response ---\n');
  await waitForPrompt((chunk) => process.stdout.write(chunk));
  process.stdout.write('\n--- end ---\n');

  await dockerPause();
  process.stderr.write(`[test] done, container paused.\n`);
}

main().catch(err => { console.error('[test] error:', err.message); process.exit(1); });
