#!/usr/bin/env node
/**
 * Tests for Telegram bot bridge.
 * Run: node tests/telegram-bot.test.mjs
 *
 * No real Telegram or Synapse calls — all mocked.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { parseAllowedChats, isAllowedChat } = await import(join(ROOT, 'dist', 'remote', 'auth.js'));
const { parseRoutingPrefix, shouldRelay, TelegramBridge } = await import(join(ROOT, 'dist', 'remote', 'telegram.js'));

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

// ── Test 1: parseAllowedChats ─────────────────────────────────────────────────

console.log('\n[Test 1] parseAllowedChats');

const list1 = parseAllowedChats('111,222,333');
assert(list1.length === 3, `parses 3 IDs`);
assert(list1[0] === 111 && list1[1] === 222 && list1[2] === 333, `correct values`);

const list2 = parseAllowedChats(' 456 , 789 ');
assert(list2.length === 2, `trims whitespace`);
assert(list2[0] === 456, `first value correct`);

assert(parseAllowedChats(undefined).length === 0, `undefined → empty array`);
assert(parseAllowedChats('').length === 0, `empty string → empty array`);
assert(parseAllowedChats('   ').length === 0, `whitespace only → empty array`);

// ── Test 2: isAllowedChat ────────────────────────────────────────────────────

console.log('\n[Test 2] isAllowedChat allowlist enforcement');

assert(isAllowedChat(111, [111, 222]), `111 is allowed`);
assert(isAllowedChat(222, [111, 222]), `222 is allowed`);
assert(!isAllowedChat(999, [111, 222]), `999 is rejected when not in list`);
assert(!isAllowedChat(111, []), `111 rejected when list is empty`);

// ── Test 3: parseRoutingPrefix ────────────────────────────────────────────────

console.log('\n[Test 3] parseRoutingPrefix');

const r1 = parseRoutingPrefix('@0 hello orch');
assert(r1.slot === 0, `@0 → slot 0`);
assert(r1.text === 'hello orch', `text extracted`);

const r2 = parseRoutingPrefix('@36 status?');
assert(r2.slot === 36, `@36 → slot 36`);
assert(r2.text === 'status?', `text extracted`);

const r3 = parseRoutingPrefix('bare message no prefix');
assert(r3.slot === 0, `no prefix → slot 0`);
assert(r3.text === 'bare message no prefix', `full text preserved`);

const r4 = parseRoutingPrefix('@unknown_thing nothing');
assert(r4.slot === 0, `non-numeric slot → defaults to 0`);

const r5 = parseRoutingPrefix('@5 multi word message here');
assert(r5.slot === 5, `@5 → slot 5`);
assert(r5.text === 'multi word message here', `multi-word text preserved`);

// ── Test 4: shouldRelay message filter ──────────────────────────────────────

console.log('\n[Test 4] shouldRelay message filter');

assert(shouldRelay({ type: 'done', needs_approval: 0 }), `type=done is relayed`);
assert(shouldRelay({ type: 'finding', needs_approval: 0 }), `type=finding is relayed`);
assert(shouldRelay({ type: 'blocked', needs_approval: 0 }), `type=blocked is relayed`);
assert(!shouldRelay({ type: 'message', needs_approval: 0 }), `type=message without approval is filtered`);
assert(!shouldRelay({ type: 'decision', needs_approval: 0 }), `type=decision without approval is filtered`);
assert(shouldRelay({ type: 'message', needs_approval: 1 }), `type=message WITH needs_approval is relayed`);
assert(shouldRelay({ type: 'decision', needs_approval: 1 }), `type=decision WITH needs_approval is relayed`);
assert(shouldRelay({ type: null, needs_approval: 1 }), `null type WITH needs_approval is relayed`);

// ── Test 5: Inline keyboard for needs_approval and request_options ───────────

console.log('\n[Test 5] Inline keyboard generation (via shouldRelay flag + message shape)');

// We test the logic by checking shouldRelay and the message fields
const approvalMsg = { type: 'message', needs_approval: 1, id: 42 };
assert(shouldRelay(approvalMsg), `needs_approval message triggers relay`);
assert(approvalMsg.id === 42, `message has id for callback_data`);

const optionsMsg = { type: 'message', needs_approval: 1, request_options: '["Option A","Option B"]', id: 99 };
assert(shouldRelay(optionsMsg), `options message triggers relay`);
const parsedOptions = JSON.parse(optionsMsg.request_options);
assert(parsedOptions.length === 2, `2 options parsed`);
assert(parsedOptions[0] === 'Option A', `first option correct`);

// ── Test 6: Cursor advances correctly ─────────────────────────────────────────

console.log('\n[Test 6] Cursor advances to highest seen message_id');

// Simulate the cursor logic
let lastSeenMsgId = 0;
const fakeMsgs = [
  { id: 10, to_id: 'human', type: 'done', needs_approval: 0 },
  { id: 15, to_id: 'human', type: 'finding', needs_approval: 0 },
  { id: 8,  to_id: 'human', type: 'done', needs_approval: 0 },
];
const newMsgs = fakeMsgs.filter(m => m.id > lastSeenMsgId && shouldRelay(m));
for (const msg of newMsgs) {
  lastSeenMsgId = Math.max(lastSeenMsgId, msg.id);
}
assert(lastSeenMsgId === 15, `cursor advances to highest id (15)`);

// Second poll: no new messages above cursor
const secondPoll = fakeMsgs.filter(m => m.id > lastSeenMsgId && shouldRelay(m));
assert(secondPoll.length === 0, `second poll returns no duplicates`);

// ── Test 7: Startup waiter mock behavior ──────────────────────────────────────

console.log('\n[Test 7] waitForSynapse retries then succeeds');

// We test the retry logic by creating a bridge with a mock fetch counter
let fetchCallCount = 0;
const originalFetch = global.fetch;
global.fetch = async (url) => {
  fetchCallCount++;
  if (fetchCallCount <= 2) {
    throw new Error('ECONNREFUSED');
  }
  return { ok: true, json: async () => ({ statuses: [], messages: [] }) };
};

const bridge = new TelegramBridge({
  token: 'FAKE_TOKEN',
  allowedChats: [111],
  synapsePort: 9999,
  polling: false,
});

// Override bot to prevent real Telegram connection
bridge.bot = {
  on: () => {},
  sendMessage: async () => {},
  answerCallbackQuery: async () => {},
  editMessageReplyMarkup: async () => {},
  stopPolling: async () => {},
};

// Test waitForSynapse with short timeouts by overriding setTimeout
const originalSetTimeout = global.setTimeout;
global.setTimeout = (fn) => { fn(); return 0; }; // immediate

let connected = false;
try {
  await bridge.waitForSynapse(5);
  connected = true;
} catch { /* ignore */ }
assert(connected, `waitForSynapse connects after 2 failures`);
assert(fetchCallCount >= 3, `made at least 3 fetch attempts`);

// Restore
global.fetch = originalFetch;
global.setTimeout = originalSetTimeout;

// ── Test 8: Startup waiter exhaustion ────────────────────────────────────────

console.log('\n[Test 8] waitForSynapse exits after max attempts');

global.fetch = async () => { throw new Error('ECONNREFUSED'); };
global.setTimeout = (fn) => { fn(); return 0; };

let exited = false;
const originalExit = process.exit;
process.exit = (code) => { exited = true; throw new Error(`exit:${code}`); };

const bridge2 = new TelegramBridge({ token: 'FAKE_TOKEN2', allowedChats: [111], synapsePort: 9998, polling: false });
bridge2.bot = { on: () => {}, sendMessage: async () => {}, stopPolling: async () => {} };

try {
  await bridge2.waitForSynapse(3);
} catch (e) {
  // expected — process.exit called
}
assert(exited, `waitForSynapse exits after max attempts`);

global.fetch = originalFetch;
global.setTimeout = originalSetTimeout;
process.exit = originalExit;

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n=== TEST SUMMARY ===`);
console.log(`PASS: ${passed}  FAIL: ${failed}`);
if (failed > 0) process.exit(1);
