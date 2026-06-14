#!/usr/bin/env node
/**
 * Probe whether `codex exec --json -` supports persistent stdin.
 *
 * Expected target behavior would be:
 *   1. write prompt 1 without stdin EOF
 *   2. receive a completed turn
 *   3. write prompt 2 to the same stdin pipe
 *   4. receive a second completed turn
 *
 * Run:
 *   node experiments/test-codex-persistent-stdin.mjs
 */

import { spawn } from 'node:child_process';

const startedAt = Date.now();
const elapsed = () => `+${((Date.now() - startedAt) / 1000).toFixed(2)}s`;

const child = spawn('codex', ['exec', '--json', '-'], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
let completedTurns = 0;
let sentSecond = false;
let exited = false;

function send(text) {
  console.log(`[probe] ${elapsed()} stdin.write: ${JSON.stringify(text)}`);
  child.stdin.write(`${text}\n`);
}

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  buffer += chunk;

  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.type === 'turn.completed') {
      completedTurns += 1;
      console.log(`[probe] ${elapsed()} observed turn.completed #${completedTurns}`);
      if (completedTurns === 1 && !sentSecond) {
        sentSecond = true;
        send('What is 7 plus 8? Reply with only the number.');
      } else if (completedTurns === 2) {
        console.log(`[probe] ${elapsed()} second turn completed; closing stdin`);
        child.stdin.end();
      }
    }
  }
});

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
});

child.on('exit', (code, signal) => {
  exited = true;
  console.log(`[probe] ${elapsed()} child exit code=${code} signal=${signal}`);
});

send('Reply with exactly: hello');

setTimeout(() => {
  if (completedTurns === 0) {
    console.log(`[probe] ${elapsed()} no turn completed before EOF; closing stdin`);
    child.stdin.end();
  }
}, 15000);

setTimeout(() => {
  if (!exited) {
    console.log(`[probe] ${elapsed()} timeout; killing child`);
    child.kill('SIGTERM');
  }
}, 45000);
