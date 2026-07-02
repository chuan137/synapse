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
    const html = DOMPurify.sanitize(marked.parse(normalized, { gfm: true, breaks: true, html: false }));
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
        // Text intentionally omitted: the reply itself lands as its own
        // STATUS row a moment later via the message stream/poll.
        card.innerHTML = '<div class="question-resolved">✓ answered</div>';
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
    const allMsgs = state.messages.get(msg.run_id) || [msg];
    msgList.appendChild(buildMessageRow(msg, allMsgs));
    msgList.scrollTop = msgList.scrollHeight;
    // A freshly arrived reply (STATUS with ref_id) may answer a QUESTION card
    // already on screen — collapse it in place instead of waiting for reload.
    if (msg.type === 'STATUS' && msg.from_agent === 'operator' && msg.ref_id) {
      const row = msgList.querySelector('.message-row[data-msg-id="' + msg.ref_id + '"]');
      const card = row && row.querySelector('.question-card:not([data-resolved])');
      if (card) {
        card.dataset.resolved = 'true';
        // This STATUS message (msg) renders as its own row right below —
        // don't echo its body here too.
        card.innerHTML = '<div class="question-resolved">✓ answered</div>';
      }
    }
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
      msgList.appendChild(buildMessageRow(msg, msgs));
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
    if (sepEl)  sepEl.style.display = run.goal ? '' : 'none';
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
