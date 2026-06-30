import { readFileSync, watch } from "fs";
import { dirname, resolve } from "path";
import {
  cmdDone,
  DEFAULT_TASK_TEMPLATE,
  MESSAGE_TYPES,
  nowIso,
} from "./commands";
import { connect, dbPath } from "./db";
import { disbandTeam } from "./monitor";

// ---------- ui ----------

const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synapse</title>
<script src="https://cdn.jsdelivr.net/npm/marked@13/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:      #1c1c1e;
    --surface: #242426;
    --border:  #38383a;
    --text:    #c8c8ca;
    --muted:   #78787e;
    --accent:  #7091f5;
    --idle:    #4ade80;
    --working: #facc15;
    --error:   #f87171;
    --p0:      #ef4444;
    --p0-bg:   #2a1212;
    --p0-text: #fca5a5;
    --tooltip-bg: rgba(240,240,240,0.95);
    --tooltip-text: #111;
    --hover-soft: rgba(255,255,255,0.02);
    --hover-bg: rgba(255,255,255,0.04);
    --selected-bg: rgba(112,145,245,0.08);
    --status-busy: #facc15;
  }
  body.light {
    --bg:      #f5f5f7;
    --surface: #ffffff;
    --border:  #d1d1d6;
    --text:    #1c1c1e;
    --muted:   #86868b;
    --accent:  #4a6ef5;
    --idle:    #16a34a;
    --working: #d97706;
    --error:   #dc2626;
    --p0:      #dc2626;
    --p0-bg:   #fef2f2;
    --p0-text: #991b1b;
    --tooltip-bg: rgba(30,30,30,0.92);
    --tooltip-text: #f5f5f7;
    --hover-soft: rgba(0,0,0,0.03);
    --hover-bg: rgba(0,0,0,0.04);
    --selected-bg: rgba(74,110,245,0.08);
    --status-busy: #d97706;
  }
  html, body { height: 100%; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', 'Menlo', monospace;
    font-size: 13px;
    line-height: 1.55;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Header ── */
  header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 16px;
    height: 44px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    transition: border-color 0.3s;
  }
  header.disconnected { border-bottom-color: var(--error); }
  .logo {
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.08em;
    color: var(--text);
    padding-right: 12px;
    border-right: 1px solid var(--border);
    white-space: nowrap;
  }
  #conn-status {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 3px 8px;
    border-radius: 4px;
    border: 1px solid;
    transition: color 0.3s, border-color 0.3s, background 0.3s;
  }
  #conn-status.connected {
    color: var(--idle);
    border-color: color-mix(in srgb, var(--idle) 40%, transparent);
    background: color-mix(in srgb, var(--idle) 8%, transparent);
  }
  #conn-status.disconnected {
    color: var(--error);
    border-color: color-mix(in srgb, var(--error) 40%, transparent);
    background: color-mix(in srgb, var(--error) 8%, transparent);
  }
  #msg-count-badge {
    margin-left: auto;
    font-size: 11px;
    color: var(--muted);
  }
  #theme-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--muted);
    font-size: 13px;
    border-radius: 4px;
    padding: 2px 7px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
    line-height: 1;
  }
  #theme-btn:hover { color: var(--text); border-color: var(--text); }
  #session-actions {
    display: none;
    border-top: 1px solid var(--border);
    background: var(--surface);
    padding: 10px 16px;
    justify-content: flex-end;
  }
  #session-actions.visible { display: flex; }
  #kill-session-btn {
    background: var(--error);
    border: 1px solid color-mix(in srgb, var(--error) 70%, transparent);
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    border-radius: 4px;
    padding: 6px 12px;
    cursor: pointer;
    line-height: 1;
  }
  #kill-session-btn:hover { opacity: 0.85; }
  #kill-session-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  #finish-run-btn {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 6px;
    padding: 6px 14px;
    cursor: pointer;
    font-size: 13px;
  }
  #finish-run-btn:hover { opacity: 0.85; }
  #finish-run-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  #stop-run-btn {
    background: var(--error);
    border: 1px solid color-mix(in srgb, var(--error) 70%, transparent);
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    border-radius: 4px;
    padding: 6px 12px;
    cursor: pointer;
    line-height: 1;
    margin-left: 8px;
  }
  #stop-run-btn:hover { opacity: 0.85; }
  #stop-run-btn:disabled { opacity: 0.45; cursor: not-allowed; }

  /* ── Layout ── */
  main {
    display: grid;
    grid-template-columns: 140px 1fr;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  /* ── Runs sidebar ── */
  #runs-sidebar {
    width: 140px;
    min-width: 140px;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg);
  }
  .sidebar-header {
    height: 41px;
    flex-shrink: 0;
    padding: 0 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--muted);
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  #runs-sidebar-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
  }
  .run-item {
    padding: 6px 10px;
    cursor: pointer;
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 12px;
    border-left: 2px solid transparent;
  }
  .run-item:hover { background: var(--hover-bg); }
  .run-item.selected { border-left-color: var(--accent); background: var(--selected-bg); }
  .run-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-top: 3px;
    flex-shrink: 0;
  }
  .run-dot[data-state="running"] {
    background: var(--status-busy);
    animation: pulse 1.5s infinite;
  }
  .run-dot[data-state="standby"] {
    background: var(--idle);
  }
  .run-dot[data-state="done"] {
    background: var(--muted);
  }
  .run-item-info { display: flex; flex-direction: column; gap: 2px; overflow: hidden; }
  .run-label { font-weight: 600; color: var(--text); }
  .run-unread { display: inline-block; margin-left: 4px; padding: 0 4px; font-size: 10px; font-weight: 700; background: var(--accent); color: #fff; border-radius: 8px; vertical-align: middle; }
  .run-session { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .run-status-badge { font-size: 10px; color: var(--muted); }
  .run-status-running { color: var(--status-busy); }
  .run-status-busy { color: var(--status-busy); }
  .run-status-idle { color: var(--status-idle, #4caf50); }
  .run-status-completed { color: var(--idle); }
  .run-status-failed { color: var(--error); }
  .run-idle-label { font-size: 0.7em; padding: 1px 4px; border-radius: 3px; margin-left: 4px; }
  .run-idle-busy { color: var(--status-busy); }
  .run-idle-idle { color: var(--status-idle, #4caf50); }
  .new-run-btn {
    margin: 8px;
    padding: 6px;
    font-size: 12px;
    background: transparent;
    border: 1px dashed var(--border);
    color: var(--muted);
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
  }
  .new-run-btn:hover { color: var(--text); border-color: var(--accent); }
  .start-run-panel {
    display: none;
    margin: 0 8px 8px;
    padding: 8px;
    border-top: 1px solid var(--border);
    gap: 6px;
    flex-direction: column;
  }
  .start-run-panel.open { display: flex; }
  #start-goal-input {
    width: 100%;
    min-height: 88px;
    resize: vertical;
    background: var(--surface);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px;
    font-family: inherit;
    font-size: 12px;
  }
  .start-run-actions { display: flex; gap: 6px; align-items: center; }
  .start-run-actions button {
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 8px;
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    background: transparent;
    color: var(--text);
  }
  #start-run-submit {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
    font-weight: 700;
  }
  #start-run-status { font-size: 11px; color: var(--muted); }

  /* ── Messages panel ── */
  #messages-panel {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--surface);
  }
  #thread-header {
    padding: 8px 14px 6px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
    flex-shrink: 0;
  }
  #thread-title {
    font-size: 12px;
    font-weight: 700;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .thread-goal {
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 600px;
    margin-top: 2px;
  }

  /* ── Agents strip ── */
  .agents-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
    min-height: 32px;
    align-items: center;
    flex-shrink: 0;
  }
  .agent-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--muted);
    cursor: pointer;
  }
  .agent-chip:hover .agent-name { color: var(--text); }
  .agent-state-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--muted);
  }
  .agent-state-dot[data-state="idle"]    { background: var(--idle); }
  .agent-state-dot[data-state="busy"]    { background: var(--working); animation: pulse 1.4s ease-in-out infinite; }
  .agent-state-dot[data-state="stopped"] { background: var(--muted); }
  .agent-name {
    font-size: 12px;
    color: var(--muted);
  }
  .agent-pending {
    background: color-mix(in srgb, var(--working) 25%, transparent);
    color: var(--working);
    font-size: 9px;
    font-weight: 700;
    padding: 1px 5px;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .agents-empty { font-size: 12px; color: var(--muted); font-style: italic; }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%       { opacity: 0.4; transform: scale(0.75); }
  }

  #messages-list {
    flex: 1;
    overflow-y: auto;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  /* ── Message rows ── */
  .message-row {
    display: flex;
    flex-direction: row;
    gap: 10px;
    align-items: flex-start;
    padding: 8px 12px;
    border-radius: 8px;
    border-left: 2px solid transparent;
  }
  .message-row.from-human {
    background: color-mix(in srgb, var(--accent) 7%, transparent);
    border-left-color: color-mix(in srgb, var(--accent) 35%, transparent);
  }
  .message-row.from-agent {
    background: color-mix(in srgb, var(--muted) 6%, var(--surface));
    transition: background 0.15s, border-left-color 0.15s;
  }
  .message-row.from-agent:hover {
    background: color-mix(in srgb, var(--muted) 12%, var(--surface));
    border-left-color: color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .message-avatar {
    width: 26px;
    height: 26px;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    flex-shrink: 0;
    margin-top: 1px;
  }
  .from-human .message-avatar { background: var(--accent); color: #fff; }
  .from-agent .message-avatar { background: var(--surface); border: 1px solid var(--border); color: var(--muted); }
  .message-body { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
  .message-header { display: flex; align-items: baseline; gap: 8px; }
  .message-sender { font-size: 11px; font-weight: 700; color: var(--text); }
  .from-human .message-sender { color: var(--accent); }
  .message-time { font-size: 10px; color: var(--muted); }
  .msg-id-label {
    font-size: 9px;
    color: var(--muted);
    opacity: 0;
    transition: opacity 0.15s;
    margin-left: auto;
  }
  .message-row:hover .msg-id-label { opacity: 0.45; }
  .msg-type-badge {
    display: inline-block;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 1px 5px;
    border-radius: 3px;
    text-transform: uppercase;
  }
  .msg-type-STATUS { background: color-mix(in srgb, var(--idle) 18%, transparent); color: var(--idle); }
  .msg-type-REVIEW { background: color-mix(in srgb, var(--working) 18%, transparent); color: var(--working); }
  .msg-type-ACK, .msg-type-INFO { background: color-mix(in srgb, var(--muted) 18%, transparent); color: var(--muted); }
  .msg-type-QUESTION { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
  .question-card { margin-top: 8px; padding: 10px 12px; background: color-mix(in srgb, var(--accent) 8%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); border-radius: 6px; }
  .question-title { font-weight: 600; font-size: 13px; margin-bottom: 6px; color: var(--text); }
  .question-options { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
  .question-opt-btn { padding: 4px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 4px; color: var(--text); cursor: pointer; font-family: inherit; font-size: 12px; }
  .question-opt-btn:hover { border-color: var(--accent); color: var(--accent); }
  .question-compose { display: flex; gap: 6px; }
  .question-input { flex: 1; padding: 4px 8px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; color: var(--text); font-family: inherit; font-size: 12px; }
  .question-input:focus { border-color: var(--accent); outline: none; }
  .question-send-btn { padding: 4px 12px; background: var(--accent); border: none; border-radius: 4px; color: #fff; cursor: pointer; font-family: inherit; font-size: 12px; }
  .question-send-btn:hover { opacity: 0.85; }
  .question-resolved { font-size: 11px; color: var(--muted); margin-top: 6px; }
  .message-content {
    font-size: 12px;
    color: var(--text);
    line-height: 1.55;
    word-break: break-word;
    white-space: normal;
  }
  .message-content > :first-child { margin-top: 0; }
  .message-content > :last-child  { margin-bottom: 0; }
  .message-content p { margin: 0 0 4px; }
  .message-content code {
    font-family: inherit;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 1px 4px;
    font-size: 11px;
    color: var(--accent);
  }
  .message-content pre {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 8px 10px;
    margin: 4px 0;
    overflow-x: auto;
  }
  .message-content pre code { background: none; border: none; padding: 0; white-space: pre; }
  .message-content ul, .message-content ol { margin: 4px 0; padding-left: 20px; }
  .message-content li { margin: 1px 0; }
  .message-content blockquote {
    margin: 4px 0; padding: 1px 10px;
    border-left: 2px solid var(--border); color: var(--muted);
  }
  .message-content a { color: var(--accent); text-decoration: none; }
  .message-content a:hover { text-decoration: underline; }
  .message-content strong { font-weight: 700; color: var(--text); }

  .empty-state {
    color: var(--muted);
    font-size: 12px;
    text-align: center;
    padding: 32px 12px;
  }

  /* ── Compose ── */
  #compose {
    border-top: 1px solid var(--border);
    background: var(--surface);
    padding: 12px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  select, input {
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    font-family: inherit;
    font-size: 12px;
    border-radius: 4px;
    padding: 5px 8px;
    outline: none;
    transition: border-color 0.15s;
  }
  select:focus, input:focus { border-color: var(--accent); }
  select option { background: var(--bg); }
  textarea#msg-input {
    width: 100%;
    resize: vertical;
    min-height: 68px;
    max-height: 180px;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text);
    font-family: inherit;
    font-size: 12px;
    border-radius: 4px;
    padding: 8px 10px;
    outline: none;
    transition: border-color 0.15s;
    line-height: 1.5;
  }
  textarea#msg-input:focus { border-color: var(--accent); }
  textarea#msg-input:disabled { opacity: 0.4; cursor: not-allowed; }
  .compose-bottom { display: flex; align-items: center; gap: 8px; }
  #send-btn {
    background: var(--accent);
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 6px 16px;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.15s;
    white-space: nowrap;
  }
  #send-btn:hover { opacity: 0.85; }
  #send-btn:disabled { opacity: 0.3; cursor: not-allowed; }
  #send-feedback { font-size: 11px; }
  #send-feedback.ok  { color: var(--idle); }
  #send-feedback.err { color: var(--error); }

  ::-webkit-scrollbar { width: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(128,120,112,0.25); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(128,120,112,0.45); }
</style>
</head>
<body>
<header id="header">
  <span class="logo">SYNAPSE</span>
  <span id="conn-status" class="disconnected">● connecting</span>
  <button id="theme-btn" title="Toggle light/dark theme">☀︎</button>
  <span id="msg-count-badge"></span>
</header>
<main>
  <aside id="runs-sidebar">
    <div class="sidebar-header"><span>Runs</span></div>
    <div id="runs-sidebar-list"></div>
    <button id="new-run-btn" class="new-run-btn" title="Start a new run">+ New Run</button>
    <div id="start-run-panel" class="start-run-panel">
      <textarea id="start-goal-input" placeholder="Goal for the new run"></textarea>
      <div class="start-run-actions">
        <button id="start-run-submit">Start</button>
        <button id="start-run-cancel">Cancel</button>
      </div>
      <span id="start-run-status"></span>
    </div>
  </aside>
  <div id="messages-panel">
    <div id="thread-header">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div>
          <div id="thread-title">Thread</div>
          <div id="thread-goal" class="thread-goal"></div>
        </div>
        <button id="stop-run-btn" style="display:none" title="Stop this run and kill tmux session">Stop Run</button>
      </div>
    </div>
    <div id="agents-strip" class="agents-strip">
      <span class="agents-empty">no agents</span>
    </div>
    <div id="messages-list"><div class="empty-state" id="empty-msgs">No messages yet.</div></div>
    <div id="session-actions">
      <button id="kill-session-btn" title="Kill the tmux session for this completed run">Kill tmux session</button>
      <button id="finish-run-btn" title="Mark run done and kill tmux session">Finish Run</button>
    </div>
    <div id="compose">
      <textarea id="msg-input" placeholder="Message… (⌘↵ or Ctrl+↵ to send)"></textarea>
      <div class="compose-bottom">
        <button id="send-btn">Send</button>
        <span id="send-feedback"></span>
      </div>
    </div>
  </div>
</main>
<script>
(function () {
  const $ = id => document.getElementById(id);
  const msgList     = $('messages-list');
  const header      = $('header');
  const connStatus  = $('conn-status');
  const msgInput    = $('msg-input');
  const sendBtn     = $('send-btn');
  const feedback    = $('send-feedback');
  const countBadge  = $('msg-count-badge');
  const sessionActions = $('session-actions');
  const killSessionBtn = $('kill-session-btn');
  const finishRunBtn   = $('finish-run-btn');
  const stopRunBtn     = $('stop-run-btn');
  const newRunBtn   = $('new-run-btn');
  const startPanel  = $('start-run-panel');
  const startGoal   = $('start-goal-input');
  const startSubmit = $('start-run-submit');
  const startCancel = $('start-run-cancel');
  const startStatus = $('start-run-status');

  let totalMsgs = 0;

  const state = {
    runs: [],
    selectedRunId: null,
    agents: new Map(),
    messages: new Map(),
    seenMsgIds: new Set(),
    unreadCounts: new Map(), // runId -> count of unseen messages
  };
  let _selectToken = 0; // race guard for selectRun fetches

  // Theme toggle
  const themeBtn = $('theme-btn');
  const savedTheme = localStorage.getItem('synapse-theme') || 'dark';
  if (savedTheme === 'light') document.body.classList.add('light');
  themeBtn.textContent = savedTheme === 'light' ? '☽' : '☀︎';
  themeBtn.addEventListener('click', () => {
    const isLight = document.body.classList.toggle('light');
    localStorage.setItem('synapse-theme', isLight ? 'light' : 'dark');
    themeBtn.textContent = isLight ? '☽' : '☀︎';
  });

  function renderMd(raw) {
    const normalized = (raw ?? '').replace(/\\n/g, '\n');
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
      const el = document.createElement('div');
      el.className = 'message-content';
      el.textContent = normalized;
      return el.outerHTML;
    }
    const html = DOMPurify.sanitize(marked.parse(normalized, { gfm: true, breaks: true }));
    const el = document.createElement('div');
    el.className = 'message-content';
    el.innerHTML = html;
    return el.outerHTML;
  }

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtTime(ts) {
    try {
      const d = new Date(ts.endsWith('Z') ? ts : ts + 'Z');
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch { return ts ?? ''; }
  }

  function initials(name) {
    const parts = String(name ?? '').split(/[-_\s]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return String(name ?? '??').slice(0, 2).toUpperCase();
  }

  function flash(msg, ok) {
    feedback.className = ok ? 'ok' : 'err';
    feedback.textContent = msg;
    setTimeout(() => { feedback.textContent = ''; feedback.className = ''; }, 3000);
  }

  function setStartStatus(msg, ok) {
    startStatus.textContent = msg || '';
    startStatus.style.color = ok ? 'var(--idle)' : 'var(--error)';
  }

  function buildMessageRow(msg) {
    const isHuman = msg.from_agent === 'operator';
    const direction = isHuman ? 'from-human' : 'from-agent';
    const sender = msg.from_agent;
    const avi = initials(sender);
    const t = (msg.type || '').toUpperCase();
    const typeBadge = t ? '<span class="msg-type-badge msg-type-' + esc(t) + '">' + esc(t) + '</span>' : '';
    const route = isHuman
      ? esc(msg.to_agent)
      : esc(msg.from_agent) + ' <span style="color:var(--muted)">→</span> ' + esc(msg.to_agent);

    const div = document.createElement('div');
    div.className = 'message-row ' + direction;
    div.dataset.msgId = msg.id;
    div.innerHTML =
      '<div class="message-avatar">' + esc(avi) + '</div>' +
      '<div class="message-body">' +
        '<div class="message-header">' +
          '<span class="message-sender">' + route + '</span>' +
          typeBadge +
          '<span class="message-time">' + esc(fmtTime(msg.created_at || '')) + '</span>' +
          '<span class="msg-id-label">#' + msg.id + '</span>' +
        '</div>' +
        renderMd(msg.body || '') +
      '</div>';

    // Render interactive question card for unread QUESTION messages to operator
    if (t === 'QUESTION' && msg.to_agent === 'operator' && msg.status !== 'read') {
      const run = state.runs.find(r => r.id === (msg.run_id || state.selectedRunId));
      const isActive = !run || run.status === 'running';
      if (isActive) {
        const card = buildQuestionCard(msg);
        div.querySelector('.message-body').appendChild(card);
      }
    }

    return div;
  }

  function buildQuestionCard(msg) {
    const card = document.createElement('div');
    card.className = 'question-card';
    card.dataset.msgId = msg.id;

    if (msg.title) {
      const titleEl = document.createElement('div');
      titleEl.className = 'question-title';
      titleEl.textContent = msg.title;
      card.appendChild(titleEl);
    }

    let options = [];
    if (msg.options) {
      try { options = JSON.parse(msg.options); } catch {}
    }

    const displayOptions = options.length > 0 ? options : ['Yes', 'No', 'OK'];
    const optDiv = document.createElement('div');
    optDiv.className = 'question-options';
    for (const opt of displayOptions) {
      const btn = document.createElement('button');
      btn.className = 'question-opt-btn';
      btn.dataset.option = opt;
      btn.textContent = opt;
      btn.addEventListener('click', () => submitQuestionReply(msg, opt, card));
      optDiv.appendChild(btn);
    }
    card.appendChild(optDiv);

    const compose = document.createElement('div');
    compose.className = 'question-compose';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'question-input';
    input.placeholder = 'Or type a reply…';
    const sendBtn = document.createElement('button');
    sendBtn.className = 'question-send-btn';
    sendBtn.textContent = 'Reply';
    sendBtn.addEventListener('click', () => {
      const val = input.value.trim();
      if (val) submitQuestionReply(msg, val, card);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const val = input.value.trim(); if (val) submitQuestionReply(msg, val, card); }
    });
    compose.appendChild(input);
    compose.appendChild(sendBtn);
    card.appendChild(compose);

    return card;
  }

  async function submitQuestionReply(msg, replyText, card) {
    card.querySelectorAll('button').forEach(b => { b.disabled = true; });
    const input = card.querySelector('.question-input');
    if (input) input.disabled = true;
    try {
      const res = await fetch('/send', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          to: msg.from_agent,
          type: 'STATUS',
          body: replyText,
          run_id: msg.run_id || state.selectedRunId,
          ref_id: msg.id,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        card.dataset.resolved = 'true';
        card.innerHTML = '<div class="question-resolved">↩ replied: ' + esc(replyText) + '</div>';
      } else {
        card.querySelectorAll('button').forEach(b => { b.disabled = false; });
        if (input) input.disabled = false;
        flash((json.error || 'reply failed'), false);
      }
    } catch (err) {
      card.querySelectorAll('button').forEach(b => { b.disabled = false; });
      if (input) input.disabled = false;
      flash(String(err), false);
    }
  }

  function appendMessage(msg) {
    totalMsgs++;
    countBadge.textContent = totalMsgs + ' messages';
    const empty = $('empty-msgs');
    if (empty) empty.remove();
    msgList.appendChild(buildMessageRow(msg));
    msgList.scrollTop = msgList.scrollHeight;
  }

  function renderMessages(msgs) {
    msgList.innerHTML = '';
    totalMsgs = 0;
    if (!msgs.length) {
      const d = document.createElement('div');
      d.className = 'empty-state'; d.id = 'empty-msgs'; d.textContent = 'No messages yet.';
      msgList.appendChild(d);
      countBadge.textContent = '';
      return;
    }
    for (const msg of msgs) {
      const empty = $('empty-msgs');
      if (empty) empty.remove();
      msgList.appendChild(buildMessageRow(msg));
      totalMsgs++;
    }
    countBadge.textContent = totalMsgs + ' messages';
    msgList.scrollTop = msgList.scrollHeight;
  }

  function renderAgentsStrip(agents) {
    const strip = $('agents-strip');
    if (!strip) return;
    if (!agents || !agents.length) {
      strip.innerHTML = '<span class="agents-empty">no agents</span>';
      return;
    }
    strip.innerHTML = agents.map(a => {
      const st = (a.status || 'unknown').toLowerCase();
      const dotState = ['idle','busy','stopped'].includes(st) ? st : 'unknown';
      const badge = a.pending_count > 0
        ? '<span class="agent-pending">' + a.pending_count + '</span>' : '';
      return '<span class="agent-chip" data-window="' + esc(a.window_name) + '">' +
        '<span class="agent-state-dot" data-state="' + esc(dotState) + '"></span>' +
        '<span class="agent-name">' + esc(a.window_name) + '</span>' +
        badge +
        '</span>';
    }).join('');
    const run = state.runs.find(r => r.id === state.selectedRunId);
    if (run) {
      strip.querySelectorAll('.agent-chip[data-window]').forEach(chip => {
        chip.addEventListener('click', () => {
          fetch('/focus-agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session: run.session, window: chip.dataset.window }),
          });
        });
      });
    }
  }

  function runHasBusyAgent(runId) {
    const agents = state.agents.get(runId) || [];
    return agents.some(a => (a.status || '').toLowerCase() === 'busy');
  }

  function runIdleLabel(run) {
    if (run.status !== 'running') return null;
    return runHasBusyAgent(run.id) ? 'Busy' : 'Idle';
  }

  function renderRunsSidebar() {
    const sidebar = $('runs-sidebar-list');
    if (!sidebar) return;
    sidebar.innerHTML = state.runs.map(run => {
      const isRunning = run.status === 'running';
      const isSelected = run.id === state.selectedRunId;
      const unread = !isSelected && (state.unreadCounts.get(run.id) || 0);
      const badge = unread ? '<span class="run-unread">' + unread + '</span>' : '';
      const dotState = !isRunning ? 'done' : runHasBusyAgent(run.id) ? 'running' : 'standby';
      const idleLabel = runIdleLabel(run);
      return '<div class="run-item' + (isSelected ? ' selected' : '') + '" data-run-id="' + run.id + '">' +
        '<span class="run-dot" data-state="' + dotState + '"></span>' +
        '<div class="run-item-info">' +
          '<span class="run-label">run #' + run.id + badge +
            (idleLabel ? '<span class="run-idle-label run-idle-' + idleLabel.toLowerCase() + '">' + idleLabel + '</span>' : '') +
          '</span>' +
          '<span class="run-session">' + esc(run.session || '') + '</span>' +
          (!isRunning ? '<span class="run-status-badge">[' + esc(run.status) + ']</span>' : '') +
        '</div>' +
      '</div>';
    }).join('');
    sidebar.querySelectorAll('.run-item').forEach(el => {
      el.addEventListener('click', () => selectRun(Number(el.dataset.runId)));
    });
  }

  function updateThreadHeader(run) {
    const titleEl = $('thread-title');
    if (!titleEl || !run) return;
    const idleLabel = runIdleLabel(run);
    const badge = idleLabel
      ? '<span class="run-status-badge run-status-' + idleLabel.toLowerCase() + '">[' + idleLabel + ']</span>'
      : '<span class="run-status-badge run-status-' + esc(run.status) + '">[' + esc(run.status) + ']</span>';
    titleEl.innerHTML = '<span>run #' + run.id + ' · ' + esc(run.session) + '</span> ' + badge;
    const goalEl = $('thread-goal');
    if (goalEl) goalEl.textContent = run.goal ? run.goal.slice(0, 80) : '';
  }

  function updateKillSessionButton(run) {
    if (!sessionActions || !killSessionBtn || !finishRunBtn) return;
    if (!run) {
      sessionActions.classList.remove('visible');
      killSessionBtn._currentRun = null;
      finishRunBtn._currentRun = null;
      if (stopRunBtn) { stopRunBtn.style.display = 'none'; stopRunBtn._currentRun = null; }
      return;
    }
    const isRunning = run.status === 'running';
    const canKill = !isRunning && run.status && !run.session_killed_at;
    const canFinish = isRunning && !run.session_killed_at;
    sessionActions.classList.toggle('visible', !!canKill);
    killSessionBtn.style.display = canKill ? '' : 'none';
    killSessionBtn.disabled = false;
    killSessionBtn._currentRun = run;
    finishRunBtn.style.display = 'none';
    finishRunBtn._currentRun = run;
    if (stopRunBtn) {
      stopRunBtn.style.display = canFinish ? '' : 'none';
      stopRunBtn.disabled = false;
      stopRunBtn._currentRun = run;
    }
  }

  async function selectRun(runId, knownRun?) {
    state.selectedRunId = runId;
    state.unreadCounts.delete(runId);
    renderRunsSidebar();

    const run = state.runs.find(r => r.id === runId) || knownRun;
    updateThreadHeader(run);
    updateKillSessionButton(run);

    renderAgentsStrip(state.agents.get(runId) || []);

    const cached = state.messages.get(runId);
    if (cached) {
      renderMessages(cached);
    } else {
      msgList.innerHTML = '<div class="empty-state">Loading…</div>';
      const token = ++_selectToken;
      try {
        const res = await fetch('/thread?run_id=' + runId);
        const data = await res.json();
        if (token !== _selectToken) return; // stale fetch, another run was selected
        if (data.messages) {
          const msgs = data.messages;
          state.messages.set(runId, msgs);
          msgs.forEach(m => state.seenMsgIds.add(m.id));
          renderMessages(msgs);
        }
      } catch {
        if (token === _selectToken)
          msgList.innerHTML = '<div class="empty-state">Failed to load thread.</div>';
      }
    }

    const isRunning = run && run.status === 'running';
    msgInput.disabled = !isRunning;
    sendBtn.disabled = !isRunning;
    msgInput.placeholder = isRunning
      ? 'Send a task to manager…'
      : 'Run ' + (run ? run.status : 'ended') + ' — read only';
  }

  function handleRunsList(payload) {
    state.runs = payload.runs || [];
    renderRunsSidebar();
    if (state.selectedRunId === null && state.runs.length > 0) {
      const firstRunning = state.runs.find(r => r.status === 'running');
      selectRun((firstRunning || state.runs[0]).id);
    } else if (state.selectedRunId !== null && !state.runs.some(r => r.id === state.selectedRunId) && state.runs.length > 0) {
      selectRun(state.runs[0].id);
    } else if (state.selectedRunId !== null) {
      const run = state.runs.find(r => r.id === state.selectedRunId);
      if (run) {
        updateThreadHeader(run);
        updateKillSessionButton(run);
      }
    }
  }

  function setConnected(ok) {
    connStatus.className = ok ? 'connected' : 'disconnected';
    connStatus.textContent = ok ? '● live' : '● reconnecting';
    header.classList.toggle('disconnected', !ok);
  }

  function connectSSE() {
    const es = new EventSource('/events');

    es.addEventListener('runs-list', e => {
      try { handleRunsList(JSON.parse(e.data)); } catch {}
    });

    es.addEventListener('agent-status', e => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.run_id !== undefined) {
          state.agents.set(payload.run_id, payload.agents);
          if (payload.run_id === state.selectedRunId) {
            renderAgentsStrip(payload.agents);
            const run = state.runs.find(r => r.id === payload.run_id);
            if (run) updateThreadHeader(run);
          }
          renderRunsSidebar();
        } else {
          // legacy fallback
          renderAgentsStrip(payload);
        }
      } catch {}
    });

    es.addEventListener('operator-thread', e => {
      try {
        const payload = JSON.parse(e.data);
        const messages = Array.isArray(payload) ? payload : (payload.messages || []);
        const run = Array.isArray(payload) ? null : (payload.run || null);
        if (run) {
          // Cache messages for this run
          state.messages.set(run.id, messages);
          messages.forEach(m => state.seenMsgIds.add(m.id));
          // Auto-select if nothing selected yet
          if (state.selectedRunId === null) {
            selectRun(run.id, run);
          } else if (run.id === state.selectedRunId) {
            renderMessages(messages);
            updateThreadHeader(run);
            updateKillSessionButton(run);
          }
        } else {
          renderMessages(messages);
        }
      } catch {}
    });

    es.addEventListener('message-stream', e => {
      try {
        const msg = JSON.parse(e.data);
        if (!state.messages.has(msg.run_id)) state.messages.set(msg.run_id, []);
        const runMsgs = state.messages.get(msg.run_id);
        if (!state.seenMsgIds.has(msg.id)) {
          state.seenMsgIds.add(msg.id);
          runMsgs.push(msg);
          if (msg.run_id === state.selectedRunId) {
            appendMessage(msg);
          } else {
            state.unreadCounts.set(msg.run_id, (state.unreadCounts.get(msg.run_id) || 0) + 1);
            renderRunsSidebar();
          }
        } else if (msg.status === 'read' && msg.type === 'QUESTION' && msg.to_agent === 'operator') {
          // Collapse any unresolved question card for this message
          const row = msgList.querySelector('.message-row[data-msg-id="' + msg.id + '"]');
          if (row) {
            const card = row.querySelector('.question-card:not([data-resolved])');
            if (card) {
              card.dataset.resolved = 'true';
              card.innerHTML = '<div class="question-resolved">↩ resolved</div>';
            }
          }
          // Update cached message status
          const cached = runMsgs.find(m => m.id === msg.id);
          if (cached) cached.status = 'read';
        }
      } catch {}
    });

    es.addEventListener('reload', () => { location.reload(); });
    es.onopen  = () => setConnected(true);
    es.onerror = () => { setConnected(false); es.close(); setTimeout(connectSSE, 2000); };
  }
  connectSSE();

  async function sendMessage() {
    const body = msgInput.value.trim();
    if (!body) { flash('body required', false); return; }
    if (!state.selectedRunId) { flash('no run selected', false); return; }
    const hasNewlines = body.includes('\n');
    const tooLong = body.length > 500;
    if ((hasNewlines || tooLong) && !sendBtn._overrideWarning) {
      const reason = hasNewlines && tooLong ? 'multiline and >500 chars'
        : hasNewlines ? 'multiline' : '>500 chars';
      flash('Warning: message is ' + reason + ' — paste into a file and send a pointer instead. Click Send again to override.', false);
      sendBtn._overrideWarning = true;
      return;
    }
    sendBtn._overrideWarning = false;
    sendBtn.disabled = true;
    try {
      const res = await fetch('/send', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          to: 'manager',
          type: 'TASK',
          body,
          run_id: state.selectedRunId,
        }),
      });
      const json = await res.json();
      if (json.ok) { msgInput.value = ''; flash('sent #' + json.id, true); }
      else flash(json.error || 'error', false);
    } catch (err) { flash(String(err), false); }
    finally { sendBtn.disabled = false; }
  }

  async function killSession() {
    if (!killSessionBtn || !sessionActions) return;
    const run = killSessionBtn._currentRun;
    if (!run || run.status === 'running') return;
    killSessionBtn.disabled = true;
    killSessionBtn.textContent = 'Killing...';
    try {
      const res = await fetch('/kill-session', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ run_id: run.id }),
      });
      const json = await res.json();
      if (json.ok) {
        run.session_killed_at = json.session_killed_at || new Date().toISOString();
        sessionActions.classList.remove('visible');
        flash('killed session ' + json.session, true);
      }
      else {
        killSessionBtn.disabled = false;
        killSessionBtn.textContent = 'Kill tmux session';
        flash(json.error || 'error', false);
      }
    } catch (err) {
      killSessionBtn.disabled = false;
      killSessionBtn.textContent = 'Kill tmux session';
      flash(String(err), false);
    }
  }

  async function finishRun() {
    const run = (stopRunBtn && stopRunBtn._currentRun) || finishRunBtn._currentRun;
    if (!run) return;
    if (!confirm('Stop this run and kill its tmux session?')) return;
    if (stopRunBtn) { stopRunBtn.disabled = true; stopRunBtn.textContent = 'Stopping...'; }
    finishRunBtn.disabled = true;
    finishRunBtn.textContent = 'Finishing...';
    try {
      const res = await fetch('/finish-run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run_id: run.id }),
      });
      const json = await res.json();
      if (json.ok) {
        run.status = 'completed';
        run.session_killed_at = json.session_killed_at || new Date().toISOString();
        updateKillSessionButton(run);
        flash('run finished and session killed', true);
      } else {
        flash('finish failed: ' + (json.error || 'unknown'), false);
        if (stopRunBtn) { stopRunBtn.disabled = false; stopRunBtn.textContent = 'Stop Run'; }
        finishRunBtn.disabled = false;
        finishRunBtn.textContent = 'Finish Run';
      }
    } catch (e) {
      flash('finish failed: ' + e.message, false);
      if (stopRunBtn) { stopRunBtn.disabled = false; stopRunBtn.textContent = 'Stop Run'; }
      finishRunBtn.disabled = false;
      finishRunBtn.textContent = 'Finish Run';
    }
  }

  async function startRun() {
    const goal = startGoal.value.trim();
    if (!goal) { setStartStatus('goal required', false); return; }
    startSubmit.disabled = true;
    setStartStatus('starting...', true);
    try {
      const res = await fetch('/start', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ goal }),
      });
      const json = await res.json();
      if (!json.ok) {
        setStartStatus(json.error || 'start failed', false);
        return;
      }
      startGoal.value = '';
      startPanel.classList.remove('open');
      setStartStatus('', true);
      if (json.run_id) selectRun(json.run_id);
      flash('started run #' + (json.run_id || '?'), true);
    } catch (err) {
      setStartStatus(String(err), false);
    } finally {
      startSubmit.disabled = false;
    }
  }

  newRunBtn.addEventListener('click', () => {
    startPanel.classList.toggle('open');
    if (startPanel.classList.contains('open')) startGoal.focus();
  });
  startSubmit.addEventListener('click', startRun);
  startCancel.addEventListener('click', () => {
    startPanel.classList.remove('open');
    setStartStatus('', true);
  });
  sendBtn.addEventListener('click', sendMessage);
  killSessionBtn.addEventListener('click', killSession);
  finishRunBtn.addEventListener('click', finishRun);
  if (stopRunBtn) stopRunBtn.addEventListener('click', finishRun);
  msgInput.addEventListener('input', () => { sendBtn._overrideWarning = false; });
  msgInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(); }
  });
  startGoal.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); startRun(); }
  });
})();
</script>
</body>
</html>
`;

const DEFAULT_UI_PORT = 7700;

/** Try to raise the terminal window on macOS using AppleScript. Best-effort; swallows errors. */
function raiseTerminal(): void {
  const TERMINALS = ['iTerm2', 'Terminal', 'Ghostty', 'Warp', 'Alacritty', 'kitty'];
  // Detect the running terminal via System Events, then activate it in a separate
  // tell block to avoid iTerm2 race where nested tell fires before System Events resolves.
  const script = `
tell application "System Events"
  set runningNames to name of every process whose background only is false
end tell
repeat with appName in {${TERMINALS.map(t => `"${t}"`).join(', ')}}
  if runningNames contains appName then
    set appStr to appName as text
    tell application appStr
      activate
      reopen
    end tell
    return appStr
  end if
end repeat`;
  try {
    const result = Bun.spawnSync(["osascript", "-e", script]);
    if (result.exitCode === 0) {
      const raised = new TextDecoder().decode(result.stdout).trim();
      if (raised) process.stderr.write(`[Synapse] raised ${raised}\n`);
    }
  } catch { /* AppleScript failed, not fatal */ }
}

// In dev mode (SYNAPSE_DEV=1), HTML is read from disk on every request.
// When running as a compiled binary, import.meta.filename is a virtual /$bunfs
// path, so resolve relative to the real executable instead.
function resolvePublicHtmlPath(): string {
  const base = dirname(import.meta.filename);
  if (base.startsWith("/$bunfs")) {
    // compiled binary: process.execPath is the real binary path
    // binary lives at <project>/bin/synapse; HTML is at <project>/src/public/index.html
    return resolve(dirname(process.execPath), "../src/public/index.html");
  }
  return resolve(base, "public/index.html");
}
const PUBLIC_HTML_PATH = resolvePublicHtmlPath();

function synapseCommand(): string[] {
  if (process.execPath === process.argv[0]) {
    return [process.execPath, process.argv[1]];
  }
  return [process.execPath];
}

export function cmdUi(flags: Record<string, string>) {
  const port = flags["port"] !== undefined ? parseInt(flags["port"], 10) : DEFAULT_UI_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error("synapse: --port must be an integer from 0 to 65535");
    process.exit(1);
  }
  const dev = !!process.env.SYNAPSE_DEV;
  const db = connect();

  const lastMessageId = new Map<number, number>(); // runId -> last seen msg id

  // SSE client registry
  const clients = new Set<ReadableStreamDefaultController>();

  function pushToAll(eventName: string, data: unknown) {
    const chunk = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const ctrl of clients) {
      try {
        ctrl.enqueue(chunk);
      } catch {
        clients.delete(ctrl);
      }
    }
  }

  function push(ctrl: ReadableStreamDefaultController, eventName: string, data: unknown) {
    ctrl.enqueue(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function pushReload() {
    const chunk = `event: reload\ndata: {}\n\n`;
    for (const ctrl of clients) {
      try {
        ctrl.enqueue(chunk);
      } catch {
        clients.delete(ctrl);
      }
    }
  }

  function activeRun() {
    return (
      (db
        .query(
          `SELECT id, session, status, goal, started_at, ended_at, session_killed_at
           FROM runs
           WHERE status='running'
           ORDER BY id DESC LIMIT 1`,
        )
        .get() as any) ??
      (db
        .query(
          `SELECT id, session, status, goal, started_at, ended_at, session_killed_at
           FROM runs
           ORDER BY id DESC LIMIT 1`,
        )
        .get() as any) ??
      null
    );
  }

  function operatorThreadMessages(run: any) {
    if (!run) {
      return db
        .query(
          `SELECT id, run_id, from_agent, to_agent, type, ref_id, body, title, options, status, created_at
           FROM messages
           WHERE (from_agent='operator' OR to_agent='operator')
           ORDER BY id DESC LIMIT 200`,
        )
        .all()
        .reverse();
    }
    return db
      .query(
        `SELECT id, run_id, from_agent, to_agent, type, ref_id, body, title, options, status, created_at
         FROM messages
         WHERE (from_agent='operator' OR to_agent='operator')
           AND run_id = ?
         ORDER BY id DESC LIMIT 200`,
      )
      .all(run.id)
      .reverse();
  }

  function pushOperatorThread(ctrl: ReadableStreamDefaultController) {
    const run = activeRun();
    const messages = operatorThreadMessages(run);
    const chunk = `event: operator-thread\ndata: ${JSON.stringify({ run, messages })}\n\n`;
    ctrl.enqueue(chunk);
  }

  function pollDb() {
    // 1. All running runs
    const runningRuns = db.query(
      `SELECT id, session, status, goal, started_at, ended_at, session_killed_at
       FROM runs WHERE status='running' ORDER BY id DESC LIMIT 10`
    ).all() as any[];

    for (const run of runningRuns) {
      const agents = db.query(
        `SELECT window_name, role, status, last_seen_at,
                (SELECT COUNT(*) FROM messages m
                 WHERE m.status='pending' AND m.to_agent=a.window_name
                   AND m.run_id = ?) AS pending_count
         FROM agents a
         WHERE (run_id=? OR run_id=0) AND window_name != 'operator'
         ORDER BY role, window_name`,
      ).all(run.id, run.id);
      pushToAll("agent-status", { run_id: run.id, agents });

      const lastId = lastMessageId.get(run.id) ?? 0;
      const newMessages = db.query(
        `SELECT id, run_id, from_agent, to_agent, type, ref_id, body, title, options, status, created_at
         FROM messages
         WHERE id > ?
           AND (from_agent='operator' OR to_agent='operator')
           AND run_id = ?
         ORDER BY id`,
      ).all(lastId, run.id) as any[];
      if (newMessages.length > 0) {
        lastMessageId.set(run.id, (newMessages[newMessages.length - 1] as any).id);
        for (const msg of newMessages) {
          pushToAll("message-stream", msg);
        }
      }
    }

    // 2. Push runs-list (all runs, not just running)
    const allRuns = db.query(
      `SELECT id, session, status, goal, started_at, ended_at, session_killed_at
       FROM runs ORDER BY id DESC LIMIT 20`
    ).all();
    pushToAll("runs-list", { runs: allRuns });
  }

  const pollTimer = setInterval(pollDb, 1000);

  // Dev mode: watch src/public/index.html and push reload to clients on change.
  let reloadDebounce: ReturnType<typeof setTimeout> | null = null;
  if (dev) {
    try {
      const watcher = watch(PUBLIC_HTML_PATH, () => {
        if (reloadDebounce) clearTimeout(reloadDebounce);
        reloadDebounce = setTimeout(() => {
          console.log("synapse ui: index.html changed — pushing reload");
          pushReload();
          reloadDebounce = null;
        }, 150);
      });
      process.on("SIGINT",  () => { watcher.close(); shutdown(); });
      process.on("SIGTERM", () => { watcher.close(); shutdown(); });
      console.log(`synapse ui: dev mode — watching ${PUBLIC_HTML_PATH}`);
    } catch {
      process.on("SIGINT",  shutdown);
      process.on("SIGTERM", shutdown);
    }
  } else {
    process.on("SIGINT",  shutdown);
    process.on("SIGTERM", shutdown);
  }

  const server = Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/" && req.method === "GET") {
        const html = dev
          ? readFileSync(PUBLIC_HTML_PATH, "utf8")
          : FRONTEND_HTML;
        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (url.pathname === "/events" && req.method === "GET") {
        let ctrl: ReadableStreamDefaultController;
        const stream = new ReadableStream({
          start(c) {
            ctrl = c;
            clients.add(ctrl);
            pushOperatorThread(ctrl);
            const allRuns = db.query(
              `SELECT id, session, status, goal, started_at, ended_at, session_killed_at
               FROM runs ORDER BY id DESC LIMIT 20`
            ).all();
            push(ctrl, "runs-list", { runs: allRuns });
            pollDb();
          },
          cancel() {
            clients.delete(ctrl);
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      if (url.pathname === "/runs" && req.method === "GET") {
        const runs = db.query(
          `SELECT id, session, status, goal, started_at, ended_at, session_killed_at
           FROM runs ORDER BY id DESC LIMIT 20`
        ).all();
        return Response.json({ runs });
      }

      if (url.pathname === "/thread" && req.method === "GET") {
        const runId = Number(url.searchParams.get("run_id"));
        if (!runId) return Response.json({ error: "missing run_id" }, { status: 400 });
        const run = db.query(
          `SELECT id, session, status, goal, started_at, ended_at, session_killed_at FROM runs WHERE id=?`
        ).get(runId) as any;
        if (!run) return Response.json({ error: "run not found" }, { status: 404 });
        const messages = db.query(
          `SELECT id, run_id, from_agent, to_agent, type, ref_id, body, title, options, status, created_at
           FROM messages
           WHERE (from_agent='operator' OR to_agent='operator') AND run_id=?
           ORDER BY id`,
        ).all(runId);
        return Response.json({ run, messages });
      }

      if (url.pathname === "/send" && req.method === "POST") {
        return req
          .json()
          .then((body: any) => {
            const { to, type, body: msgBody, run_id, ref_id } = body ?? {};
            if (!to || !type || !msgBody) {
              return Response.json(
                { ok: false, error: "missing to, type, or body" },
                { status: 400 },
              );
            }
            if (!MESSAGE_TYPES.has(type)) {
              return Response.json(
                {
                  ok: false,
                  error: `type must be one of ${[...MESSAGE_TYPES].sort()}`,
                },
                { status: 400 },
              );
            }
            if (to === "broadcast") {
              return Response.json(
                {
                  ok: false,
                  error: "broadcast messages are no longer supported; send to a specific agent",
                },
                { status: 400 },
              );
            }
            const run = run_id
              ? (db.query(`SELECT id FROM runs WHERE id=?`).get(run_id) as any)
              : activeRun();
            const known = db
              .query(
                "SELECT 1 FROM agents WHERE window_name=? AND (run_id=? OR run_id=0)",
              )
              .get(to, run?.id ?? -1);
            if (!known) {
              console.error(
                `synapse ui: warning — '${to}' not in agents registry (sending anyway)`,
              );
            }
            const result = db.run(
              `INSERT INTO messages (run_id, from_agent, to_agent, type, ref_id, body) VALUES (?, 'operator', ?, ?, ?, ?)`,
              [run?.id ?? null, to, type, ref_id ?? null, msgBody],
            );
            return Response.json({
              ok: true,
              id: Number(result.lastInsertRowid),
            });
          })
          .catch(() =>
            Response.json(
              { ok: false, error: "invalid JSON" },
              { status: 400 },
            ),
          );
      }

      if (url.pathname === "/focus-agent" && req.method === "POST") {
        return req.json().then((body: any) => {
          const { session, window: win } = body ?? {};
          if (!session || !win) {
            return Response.json({ ok: false, error: "missing session or window" }, { status: 400 });
          }
          const target = `${session}:${win}`;
          const selectResult = Bun.spawnSync(["tmux", "select-window", "-t", target]);
          if (selectResult.exitCode !== 0) {
            const stderr = new TextDecoder().decode(selectResult.stderr).trim();
            return Response.json({ ok: false, error: stderr || `exit ${selectResult.exitCode}` }, { status: 500 });
          }
          // Redirect all tmux clients (regardless of their current session) to the target window
          const listResult = Bun.spawnSync(["tmux", "list-clients", "-F", "#{client_name} #{session_name}"]);
          const clientLines = new TextDecoder().decode(listResult.stdout).trim().split('\n').filter(Boolean);
          if (clientLines.length === 0) {
            process.stderr.write(`[Synapse] switch-client: no tmux clients found\n`);
          } else {
            for (const line of clientLines) {
              const clientName = line.split(' ')[0];
              const switchResult = Bun.spawnSync(["tmux", "switch-client", "-c", clientName, "-t", target]);
              if (switchResult.exitCode !== 0) {
                const stderr = new TextDecoder().decode(switchResult.stderr).trim();
                process.stderr.write(`[Synapse] switch-client -c ${clientName} failed: ${stderr}\n`);
              }
            }
          }
          raiseTerminal();
          return Response.json({ ok: true });
        }).catch(() => Response.json({ ok: false, error: "invalid JSON" }, { status: 400 }));
      }

      if (url.pathname === "/start" && req.method === "POST") {
        return req
          .json()
          .then((body: any) => {
            const goal = String(body?.goal ?? "").trim();
            const configPath = String(body?.config_path ?? DEFAULT_TASK_TEMPLATE).trim();
            if (!goal) {
              return Response.json(
                { ok: false, error: "missing goal" },
                { status: 400 },
              );
            }
            const args = [...synapseCommand(), "start", configPath, "--goal", goal];
            if (body?.no_monitor) args.push("--no-monitor");
            const result = Bun.spawnSync({
              cmd: args,
              env: { ...process.env, SYNAPSE_DB: dbPath() },
            });
            const stdout = result.stdout.toString();
            const stderr = result.stderr.toString();
            if (result.exitCode !== 0) {
              return Response.json(
                { ok: false, error: stderr.trim() || stdout.trim() || "start failed" },
                { status: 500 },
              );
            }
            const runId = Number(stdout.match(/run #(\d+)/)?.[1] ?? 0) || null;
            pollDb();
            return Response.json({ ok: true, run_id: runId, stdout });
          })
          .catch(() =>
            Response.json(
              { ok: false, error: "invalid JSON" },
              { status: 400 },
            ),
          );
      }

      if (url.pathname === "/kill-session" && req.method === "POST") {
        return req.json().then((body: any) => {
          const reqRunId = body?.run_id ? Number(body.run_id) : null;
          const run = reqRunId
            ? (db.query(`SELECT id, session, status, goal, started_at, ended_at, session_killed_at FROM runs WHERE id=?`).get(reqRunId) as any)
            : activeRun();
          if (!run) {
            return Response.json(
              { ok: false, error: "no run selected" },
              { status: 404 },
            );
          }
          if (run.status === "running") {
            return Response.json(
              { ok: false, error: "run is still running" },
              { status: 409 },
            );
          }
          const runId = Number(run.id);
          const session = run.session;
          db.run(
            "INSERT INTO events (agent, type, summary, created_at) VALUES ('operator', 'decision', ?, ?)",
            [`requested tmux session kill for terminal run ${runId}; session ${session}`, nowIso()],
          );
          const result = disbandTeam(db, session, runId, (s) => console.log(`[kill-session] ${s}`));
          pollDb();
          if (!result.sessionKilled) {
            return Response.json(
              { ok: false, run_id: runId, session, error: result.error || "tmux session still exists" },
              { status: 500 },
            );
          }
          const updated = db
            .query("SELECT session_killed_at FROM runs WHERE id=?")
            .get(runId) as any;
          return Response.json({ ok: true, run_id: runId, session, session_killed_at: updated?.session_killed_at ?? null });
        });
      }

      if (url.pathname === "/finish-run" && req.method === "POST") {
        return req.json().then((body: any) => {
          const reqRunId = body?.run_id ? Number(body.run_id) : null;
          const run = reqRunId
            ? (db.query(`SELECT id, session, status, goal, started_at, ended_at, session_killed_at FROM runs WHERE id=?`).get(reqRunId) as any)
            : activeRun();
          if (!run) {
            return Response.json(
              { ok: false, error: "no run selected" },
              { status: 404 },
            );
          }
          if (run.status !== "running") {
            return Response.json(
              { ok: false, error: "run is not running" },
              { status: 409 },
            );
          }
          const runId = Number(run.id);
          const session = run.session;
          cmdDone("done", "Operator finished the run from UI.", "operator", null, runId);
          const result = disbandTeam(db, session, runId, (s) => console.log(`[finish-run] ${s}`));
          pollDb();
          if (!result.sessionKilled) {
            return Response.json(
              { ok: false, run_id: runId, session, error: result.error || "tmux session still exists" },
              { status: 500 },
            );
          }
          const updated = db
            .query("SELECT session_killed_at FROM runs WHERE id=?")
            .get(runId) as any;
          return Response.json({ ok: true, run_id: runId, session, session_killed_at: updated?.session_killed_at ?? null });
        });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  function shutdown() {
    clearInterval(pollTimer);
    for (const ctrl of clients) {
      try { ctrl.close(); } catch {}
    }
    server.stop(true);
    process.exit(0);
  }

  console.log(`synapse ui: listening on http://localhost:${server.port}`);
  console.log(`  GET  /        — dashboard`);
  console.log(`  GET  /events  — SSE stream (agent-status, message-stream, reload)`);
  console.log(`  POST /send    — {to, type, body}`);
}
