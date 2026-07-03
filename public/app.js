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
  let activeQuestionMsgId = null; // id of the QUESTION currently shown in compose

  const state = {
    runs: [],
    selectedRunId: null,
    agents: new Map(),
    messages: new Map(),
    seenMsgIds: new Set(),
    unreadCounts: new Map(), // runId -> count of unseen messages
    managerActivity: new Map(), // runId -> sorted array of activity items
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
    const html = DOMPurify.sanitize(marked.parse(normalized, { gfm: true, breaks: true, html: false }));
    const el = document.createElement('div');
    el.className = 'message-content';
    el.innerHTML = html;
    return el.outerHTML;
  }

  // Highlight patterns in plain text nodes: file paths, --flags, numbers with units.
  // Skips nodes already inside <code> or <pre> so we don't double-wrap.
  const HIGHLIGHT_RE = /(`[^`]+`|(?:[\w./-]+\/[\w./-]+(?:\.[\w]+)?)|--[\w-]+(?:=\S+)?|\b\d+(?:\.\d+)?\s*(?:KB|MB|GB|ms|s|px|%)\b)/g;

  const SEMANTIC_OK  = /^(pass(?:ed|es)?|ok|lgtm|fixed|done|success(?:ful)?|approved|merged|clean|green|built|deployed)$/i;
  const SEMANTIC_ERR = /^(fail(?:ed|s)?|error(?:s)?|broken|blocked|rejected|crash(?:ed)?|abort(?:ed)?|timeout(?:ed)?)$/i;

  function colorStrong(container) {
    container.querySelectorAll('strong').forEach(el => {
      const t = el.textContent.trim();
      if (SEMANTIC_OK.test(t))  { el.classList.add('msg-strong-ok');  return; }
      if (SEMANTIC_ERR.test(t)) { el.classList.add('msg-strong-err'); return; }
      el.classList.add('msg-strong-key');
    });
  }

  function autoHighlight(container) {
    colorStrong(container);
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let p = node.parentElement;
        while (p && p !== container) {
          if (p.tagName === 'CODE' || p.tagName === 'PRE' || p.tagName === 'A') return NodeFilter.FILTER_REJECT;
          p = p.parentElement;
        }
        return HIGHLIGHT_RE.test(node.textContent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    for (const textNode of nodes) {
      HIGHLIGHT_RE.lastIndex = 0;
      const text = textNode.textContent;
      if (!HIGHLIGHT_RE.test(text)) continue;
      HIGHLIGHT_RE.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0, m;
      while ((m = HIGHLIGHT_RE.exec(text)) !== null) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const code = document.createElement('code');
        code.className = 'msg-inline-code';
        code.textContent = m[0].replace(/^`|`$/g, '');
        frag.appendChild(code);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode.replaceChild(frag, textNode);
    }
  }

  function renderMdHighlighted(raw) {
    const normalized = (raw ?? '').replace(/\\n/g, '\n');
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
      const el = document.createElement('div');
      el.className = 'message-content';
      el.textContent = normalized;
      return el;
    }
    const html = DOMPurify.sanitize(marked.parse(normalized, { gfm: true, breaks: true, html: false }));
    const el = document.createElement('div');
    el.className = 'message-content';
    el.innerHTML = html;
    autoHighlight(el);
    return el;
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
    const fb = $('send-feedback');
    if (!fb) return;
    fb.className = ok ? 'ok' : 'err';
    fb.textContent = msg;
    setTimeout(() => { const f = $('send-feedback'); if (f) { f.textContent = ''; f.className = ''; } }, 3000);
  }

  function setStartStatus(msg, ok) {
    startStatus.textContent = msg || '';
    startStatus.style.color = ok ? 'var(--idle)' : 'var(--error)';
  }

  function buildMessageRow(msg, allMsgs) {
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

    const useHighlight = t === 'REPLY' ||
                         (!isHuman && t === 'TASK');
    div.innerHTML =
      '<div class="message-avatar">' + esc(avi) + '</div>' +
      '<div class="message-body">' +
        '<div class="message-header">' +
          '<span class="message-sender">' + route + '</span>' +
          typeBadge +
          '<span class="message-time">' + esc(fmtTime(msg.created_at || '')) + '</span>' +
          '<span class="msg-id-label">#' + msg.id + '</span>' +
        '</div>' +
        (useHighlight ? '' : renderMd(msg.body || '')) +
      '</div>';
    if (useHighlight) {
      div.querySelector('.message-body').appendChild(renderMdHighlighted(msg.body || ''));
    }

    // Render interactive question card for QUESTION messages to operator that
    // don't already have a reply. We key "answered" off an actual STATUS reply
    // row (ref_id -> this message, from operator) rather than msg.status: the
    // status column is a separate agent-inbox pending/delivered/read pipeline
    // that the operator's web reply never touches, so relying on it left the
    // card reappearing (unanswered) on every reload even after a real reply
    // had been persisted.
    if (t === 'QUESTION' && msg.to_agent === 'operator') {
      const reply = (allMsgs || []).find(
        m => m.ref_id === msg.id && m.from_agent === 'operator',
      );
      if (reply) {
        const resolvedDiv = document.createElement('div');
        resolvedDiv.className = 'question-resolved';
        // Don't repeat the reply text here — the reply itself is a real
        // STATUS message that already renders as its own row further down
        // the thread. Echoing it here just duplicates it on screen.
        resolvedDiv.textContent = '✓ answered';
        div.querySelector('.message-body').appendChild(resolvedDiv);
      } else {
        const run = state.runs.find(r => r.id === (msg.run_id || state.selectedRunId));
        const isActive = !run || run.status === 'running';
        if (isActive) {
          const card = buildQuestionCard(msg);
          // If this question is shown in the compose area, mark it display-only
          if (activeQuestionMsgId === msg.id) {
            card.classList.add('question-card-in-compose');
          }
          div.querySelector('.message-body').appendChild(card);
        }
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

    // No generic Yes/No/OK fallback: a QUESTION with no real options means the
    // agent didn't specify them (now rejected at send-time — see cmdSend), or
    // this is an older message from before that check existed. Either way,
    // showing made-up buttons is misleading, so just fall through to the
    // free-text reply box below.
    if (options.length > 0) {
      const optDiv = document.createElement('div');
      optDiv.className = 'question-options';
      for (const opt of options) {
        const btn = document.createElement('button');
        btn.className = 'question-opt-btn';
        btn.dataset.option = opt;
        btn.textContent = opt;
        btn.addEventListener('click', () => submitQuestionReply(msg, opt, card));
        optDiv.appendChild(btn);
      }
      card.appendChild(optDiv);
    }

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

  function enterQuestionMode(msg) {
    activeQuestionMsgId = msg.id;
    // Mark the existing inline thread card as display-only
    const row = msgList.querySelector('.message-row[data-msg-id="' + msg.id + '"]');
    if (row) {
      const inlineCard = row.querySelector('.question-card:not([data-resolved])');
      if (inlineCard) inlineCard.classList.add('question-card-in-compose');
    }
    const compose = $('compose');
    compose.innerHTML = '';
    compose.className = 'compose-question-mode';

    const preview = document.createElement('div');
    preview.className = 'compose-question-preview';
    if (msg.title) {
      const t = document.createElement('span');
      t.className = 'compose-question-title';
      t.textContent = msg.title;
      preview.appendChild(t);
    }
    const from = document.createElement('span');
    from.className = 'compose-question-from';
    from.textContent = 'from ' + (msg.from_agent || '?') + ' · #' + msg.id;
    preview.appendChild(from);
    compose.appendChild(preview);

    let options = [];
    if (msg.options) { try { options = JSON.parse(msg.options); } catch {} }
    if (options.length > 0) {
      const optDiv = document.createElement('div');
      optDiv.className = 'question-options';
      for (const opt of options) {
        const btn = document.createElement('button');
        btn.className = 'question-opt-btn';
        btn.dataset.option = opt;
        btn.textContent = opt;
        btn.addEventListener('click', () => submitQuestionReply(msg, opt, null));
        optDiv.appendChild(btn);
      }
      compose.appendChild(optDiv);
    }

    const freeRow = document.createElement('div');
    freeRow.className = 'compose-bottom';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'question-input compose-question-input';
    input.id = 'compose-question-input';
    input.placeholder = 'Or type a custom reply…';
    const replyBtn = document.createElement('button');
    replyBtn.className = 'question-send-btn';
    replyBtn.id = 'compose-question-send';
    replyBtn.textContent = 'Reply';
    replyBtn.addEventListener('click', () => {
      const val = input.value.trim();
      if (val) submitQuestionReply(msg, val, null);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); const val = input.value.trim(); if (val) submitQuestionReply(msg, val, null); }
    });
    freeRow.appendChild(input);
    freeRow.appendChild(replyBtn);
    const feedbackSpan = document.createElement('span');
    feedbackSpan.id = 'send-feedback';
    freeRow.appendChild(feedbackSpan);
    compose.appendChild(freeRow);
    input.focus();
  }

  function exitQuestionMode() {
    activeQuestionMsgId = null;
    const compose = $('compose');
    compose.className = '';
    compose.innerHTML =
      '<div class="compose-input-wrap">' +
        '<textarea id="msg-input" placeholder="Message… (⌘↵ or Ctrl+↵ to send)"></textarea>' +
        '<button id="send-btn" title="Send (⌘↵)">↑</button>' +
      '</div>' +
      '<span id="send-feedback"></span>';
    // Re-wire the restored elements
    const newInput = $('msg-input');
    const newSendBtn = $('send-btn');
    const run = state.runs.find(r => r.id === state.selectedRunId);
    const isRunning = run && run.status === 'running';
    newInput.disabled = !isRunning;
    newSendBtn.disabled = !isRunning;
    newInput.placeholder = isRunning
      ? 'Send a task to manager…'
      : 'Run ' + (run ? run.status : 'ended') + ' — read only';
    newSendBtn.addEventListener('click', sendMessage);
    newInput.addEventListener('input', () => { newSendBtn._overrideWarning = false; });
    newInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendMessage(); }
    });
  }

  // Find the most recent unresolved QUESTION for operator in the current run.
  function findPendingQuestion() {
    const runId = state.selectedRunId;
    if (runId === null) return null;
    const run = state.runs.find(r => r.id === runId);
    // If run not yet loaded in state.runs, assume active (operator-thread fires before runs-list)
    if (run && run.status !== 'running') return null;
    const msgs = state.messages.get(runId) || [];
    // most recent first
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.type !== 'QUESTION' || m.to_agent !== 'operator') continue;
      const answered = msgs.some(r => r.ref_id === m.id && r.from_agent === 'operator');
      if (!answered) return m;
    }
    return null;
  }

  function syncComposeMode() {
    const pending = findPendingQuestion();
    if (pending) {
      if (activeQuestionMsgId !== pending.id) enterQuestionMode(pending);
    } else {
      if (activeQuestionMsgId !== null) exitQuestionMode();
    }
  }

  async function submitQuestionReply(msg, replyText, card) {
    // Disable UI in compose-question mode
    const composeEl = $('compose');
    const inComposeMode = composeEl && composeEl.classList.contains('compose-question-mode');
    if (inComposeMode) {
      composeEl.querySelectorAll('button').forEach(b => { b.disabled = true; });
      const ci = $('compose-question-input');
      if (ci) ci.disabled = true;
    }
    // Also disable inline card if provided
    if (card) {
      card.querySelectorAll('button').forEach(b => { b.disabled = true; });
      const input = card.querySelector('.question-input');
      if (input) input.disabled = true;
    }
    try {
      const res = await fetch('/send', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          to: msg.from_agent,
          type: 'REPLY',
          body: replyText,
          run_id: msg.run_id || state.selectedRunId,
          ref_id: msg.id,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        // Restore compose to normal
        exitQuestionMode();
        // Update the inline thread card to resolved state
        const row = msgList.querySelector('.message-row[data-msg-id="' + msg.id + '"]');
        if (row) {
          const inlineCard = row.querySelector('.question-card:not([data-resolved])');
          if (inlineCard) {
            inlineCard.classList.remove('question-card-in-compose');
            inlineCard.dataset.resolved = 'true';
            inlineCard.innerHTML = '<div class="question-resolved">✓ answered</div>';
          }
        }
        if (card && card !== null) {
          card.dataset.resolved = 'true';
          card.innerHTML = '<div class="question-resolved">✓ answered</div>';
        }
      } else {
        if (inComposeMode) {
          composeEl.querySelectorAll('button').forEach(b => { b.disabled = false; });
          const ci = $('compose-question-input');
          if (ci) ci.disabled = false;
        }
        if (card) {
          card.querySelectorAll('button').forEach(b => { b.disabled = false; });
          const input = card.querySelector('.question-input');
          if (input) input.disabled = false;
        }
        flash((json.error || 'reply failed'), false);
      }
    } catch (err) {
      if (inComposeMode) {
        composeEl.querySelectorAll('button').forEach(b => { b.disabled = false; });
        const ci = $('compose-question-input');
        if (ci) ci.disabled = false;
      }
      if (card) {
        card.querySelectorAll('button').forEach(b => { b.disabled = false; });
        const input = card.querySelector('.question-input');
        if (input) input.disabled = false;
      }
      flash(String(err), false);
    }
  }

  function buildActivityMarker(item) {
    const icons = { TASK: '↳', PROGRESS: '•' };
    const icon = icons[item.type] || '•';
    const div = document.createElement('div');
    div.className = 'activity-marker activity-' + item.type;
    div.innerHTML =
      '<span class="activity-icon">' + esc(icon) + '</span>' +
      '<span class="activity-time">' + esc(fmtTime(item.created_at)) + '</span>';
    const timeSpan = div.querySelector('.activity-time');
    const bodyEl = renderMdHighlighted(item.body);
    div.insertBefore(bodyEl, timeSpan);
    if ((item.body || '').length > 80) {
      div.classList.add('activity-collapsed');
      div.style.cursor = 'pointer';
      div.addEventListener('click', () => {
        div.classList.toggle('activity-collapsed');
      });
    }
    return div;
  }

  function appendMessage(msg) {
    const empty = $('empty-msgs');
    if (empty) empty.remove();
    if (msg.type === 'PROGRESS') {
      msgList.appendChild(buildActivityMarker(msg));
      msgList.scrollTop = msgList.scrollHeight;
      syncComposeMode();
      return;
    }
    totalMsgs++;
    countBadge.textContent = totalMsgs + ' messages';
    const allMsgs = state.messages.get(msg.run_id) || [msg];
    msgList.appendChild(buildMessageRow(msg, allMsgs));
    msgList.scrollTop = msgList.scrollHeight;
    // A freshly arrived reply (REPLY with ref_id) may answer a QUESTION card
    // already on screen — collapse it in place instead of waiting for reload.
    if (msg.type === 'REPLY' && msg.from_agent === 'operator' && msg.ref_id) {
      const row = msgList.querySelector('.message-row[data-msg-id="' + msg.ref_id + '"]');
      const card = row && row.querySelector('.question-card:not([data-resolved])');
      if (card) {
        card.classList.remove('question-card-in-compose');
        card.dataset.resolved = 'true';
        // This STATUS message (msg) renders as its own row right below —
        // don't echo its body here too.
        card.innerHTML = '<div class="question-resolved">✓ answered</div>';
      }
    }
    syncComposeMode();
  }

  function renderThread() {
    const runId = state.selectedRunId;
    const msgs = (runId !== null ? state.messages.get(runId) : null) || [];
    const activity = (runId !== null ? state.managerActivity.get(runId) : null) || [];
    renderMessages(msgs, activity);
  }

  function renderMessages(msgs, activity) {
    msgList.innerHTML = '';
    totalMsgs = 0;
    const combined = [];
    for (const m of msgs) combined.push({ _kind: 'msg', _ts: m.created_at, data: m });
    for (const a of (activity || [])) combined.push({ _kind: 'activity', _ts: a.created_at, data: a });
    combined.sort((a, b) => (a._ts < b._ts ? -1 : a._ts > b._ts ? 1 : 0));

    if (!combined.length) {
      const d = document.createElement('div');
      d.className = 'empty-state'; d.id = 'empty-msgs'; d.textContent = 'No messages yet.';
      msgList.appendChild(d);
      countBadge.textContent = '';
      return;
    }
    for (const item of combined) {
      const empty = $('empty-msgs');
      if (empty) empty.remove();
      if (item._kind === 'msg') {
        if (item.data.type === 'PROGRESS') {
          msgList.appendChild(buildActivityMarker(item.data));
        } else {
          msgList.appendChild(buildMessageRow(item.data, msgs));
          totalMsgs++;
        }
      } else {
        const a = item.data;
        msgList.appendChild(buildActivityMarker(a));
      }
    }
    countBadge.textContent = totalMsgs + ' messages';
    msgList.scrollTop = msgList.scrollHeight;
    syncComposeMode();
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
      return '<div class="run-item' + (isSelected ? ' selected' : '') + '" data-run-id="' + run.id + '">' +
        '<span class="run-dot" data-state="' + dotState + '"></span>' +
        '<div class="run-item-info">' +
          '<span class="run-label">run #' + run.id + badge +
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
    titleEl.innerHTML = '<span>run #' + run.id + ' · ' + esc(run.session) + '</span> ';
    const goalEl = $('thread-goal');
    const sepEl  = $('thread-sep');
    if (goalEl) goalEl.textContent = run.goal ? run.goal.slice(0, 80) : '';
    if (sepEl)  sepEl.style.display = run.goal ? 'inline' : 'none';
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
      stopRunBtn.disabled = canFinish && runHasBusyAgent(run.id);
      stopRunBtn._currentRun = run;
    }
  }

  async function selectRun(runId, knownRun) {
    state.selectedRunId = runId;
    state.unreadCounts.delete(runId);
    renderRunsSidebar();

    const run = state.runs.find(r => r.id === runId) || knownRun;
    updateThreadHeader(run);
    updateKillSessionButton(run);

    renderAgentsStrip(state.agents.get(runId) || []);

    const cached = state.messages.get(runId);
    if (cached) {
      renderThread();
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
          state.managerActivity.set(runId, data.managerActivity || []);
          renderThread();
        }
      } catch {
        if (token === _selectToken)
          msgList.innerHTML = '<div class="empty-state">Failed to load thread.</div>';
      }
    }

    const isRunning = run && run.status === 'running';
    // Use live lookups since compose DOM may be rebuilt by question mode
    const mi = $('msg-input');
    const sb = $('send-btn');
    if (mi) {
      mi.disabled = !isRunning;
      mi.placeholder = isRunning
        ? 'Send a task to manager…'
        : 'Run ' + (run ? run.status : 'ended') + ' — read only';
    }
    if (sb) sb.disabled = !isRunning;
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
      // Runs list arrived after operator-thread — re-sync compose mode now that
      // we know the run's status.
      syncComposeMode();
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
        const managerActivity = Array.isArray(payload) ? [] : (payload.managerActivity || []);
        if (run) {
          // Cache messages and activity for this run
          state.messages.set(run.id, messages);
          messages.forEach(m => state.seenMsgIds.add(m.id));
          state.managerActivity.set(run.id, managerActivity);
          // Auto-select if nothing selected yet
          if (state.selectedRunId === null) {
            selectRun(run.id, run);
          } else if (run.id === state.selectedRunId) {
            renderThread();
            updateThreadHeader(run);
            updateKillSessionButton(run);
          }
        } else {
          renderMessages(messages, []);
        }
      } catch {}
    });

    es.addEventListener('manager-activity-stream', e => {
      try {
        const { run_id, items } = JSON.parse(e.data);
        const existing = state.managerActivity.get(run_id) || [];
        state.managerActivity.set(run_id, [...existing, ...items]);
        if (run_id === state.selectedRunId) renderThread();
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
              card.classList.remove('question-card-in-compose');
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
    const mi = $('msg-input');
    const sb = $('send-btn');
    const body = mi ? mi.value.trim() : '';
    if (!body) { flash('body required', false); return; }
    if (!state.selectedRunId) { flash('no run selected', false); return; }
    const hasNewlines = body.includes('\n');
    const tooLong = body.length > 500;
    if ((hasNewlines || tooLong) && !sb._overrideWarning) {
      const reason = hasNewlines && tooLong ? 'multiline and >500 chars'
        : hasNewlines ? 'multiline' : '>500 chars';
      flash('Warning: message is ' + reason + ' — paste into a file and send a pointer instead. Click Send again to override.', false);
      sb._overrideWarning = true;
      return;
    }
    if (sb) sb._overrideWarning = false;
    if (sb) sb.disabled = true;
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
      if (json.ok) { if (mi) mi.value = ''; }
      else flash(json.error || 'error', false);
    } catch (err) { flash(String(err), false); }
    finally { const s = $('send-btn'); if (s) s.disabled = false; }
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
