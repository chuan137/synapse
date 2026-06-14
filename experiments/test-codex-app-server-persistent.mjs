#!/usr/bin/env node
/**
 * Probe whether `codex app-server --stdio` can be used as a persistent
 * request channel for multiple Codex turns.
 *
 * Run:
 *   node experiments/test-codex-app-server-persistent.mjs
 */

import { spawn } from 'node:child_process';

const startedAt = Date.now();
const elapsed = () => `+${((Date.now() - startedAt) / 1000).toFixed(2)}s`;

const child = spawn('codex', ['app-server', '--stdio'], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
});

let nextId = 1;
let buffer = '';
let threadId = null;
let firstTurnCompleted = false;
let secondTurnCompleted = false;
let exited = false;
let noResponseTimer = null;
let timeoutTimer = null;

function request(method, params) {
  const id = nextId++;
  const msg = { id, method, params };
  console.log(`[probe] ${elapsed()} -> ${method} #${id}`);
  child.stdin.write(`${JSON.stringify(msg)}\n`);
  return id;
}

function textInput(text) {
  return [{ type: 'text', text, text_elements: [] }];
}

function handleMessage(msg) {
  const method = msg.method;
  if (msg.id) {
    console.log(`[probe] ${elapsed()} <- response #${msg.id}${msg.error ? ` error=${msg.error.message}` : ''}`);
  }
  if (method) {
    console.log(`[probe] ${elapsed()} <- notification ${method}`);
  }

  if (msg.id === 2 && msg.result?.thread?.id) {
    threadId = msg.result.thread.id;
    request('turn/start', {
      threadId,
      input: textInput('Reply with exactly: hello'),
    });
  }

  if (method === 'turn/completed' && msg.params?.threadId === threadId) {
    if (!firstTurnCompleted) {
      firstTurnCompleted = true;
      request('turn/start', {
        threadId,
        input: textInput('What is 7 plus 8? Reply with only the number.'),
      });
    } else if (!secondTurnCompleted) {
      secondTurnCompleted = true;
      console.log(`[probe] ${elapsed()} observed second turn completion; closing stdin`);
      child.stdin.end();
    }
  }
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
    try {
      handleMessage(JSON.parse(line));
    } catch {
      console.log(`[probe] ${elapsed()} non-json line: ${line}`);
    }
  }
});

child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => process.stderr.write(chunk));

child.on('exit', (code, signal) => {
  exited = true;
  clearTimeout(noResponseTimer);
  clearTimeout(timeoutTimer);
  console.log(`[probe] ${elapsed()} child exit code=${code} signal=${signal}`);
});

request('initialize', {
  clientInfo: { name: 'synapse-probe', title: 'Synapse Probe', version: '0.0.0' },
  capabilities: { experimentalApi: true, requestAttestation: false },
});
request('thread/start', {
  cwd: process.cwd(),
  ephemeral: true,
});

noResponseTimer = setTimeout(() => {
  if (!exited && !threadId) {
    console.log(`[probe] ${elapsed()} no response; closing stdin`);
    child.stdin.end();
  }
}, 10000);

timeoutTimer = setTimeout(() => {
  if (!exited) {
    console.log(`[probe] ${elapsed()} timeout; killing child`);
    child.kill('SIGTERM');
  }
}, 60000);
