(function () {
  const $ = id => document.getElementById(id);
  const msgList     = $('messages-list');
  const header      = $('header');
  const connStatus  = $('conn-status');
  const msgInput    = $('msg-input');
  const sendBtn     = $('send-btn');
  const sessionActions = $('session-actions');
  const killSessionBtn = $('kill-session-btn');
  const finishRunBtn   = $('finish-run-btn');
  const stopRunBtn     = $('stop-run-btn');
  const startPanel  = $('start-run-panel');
  const startGoal   = $('start-goal-input');
  const startSubmit = $('start-run-submit');
  const startCancel = $('start-run-cancel');
  const startStatus = $('start-run-status');
  const fileViewerPanel = $('file-viewer-panel');
  const fileViewerBody  = $('file-viewer-body');
  const fileViewerClose = $('file-viewer-close');
  const fileViewerOpenExt = $('file-viewer-open-ext');
  const fileViewerBreadcrumb = $('file-viewer-breadcrumb');
  const fileViewerLineCount = $('file-viewer-linecount');
  const fileViewerCopy = $('file-viewer-copy');
  const fileViewerWrapToggle = $('file-viewer-wrap-toggle');
  const fileViewerMaximize = $('file-viewer-maximize');
  const fileViewerSearch = $('file-viewer-search');
  const fileViewerSearchCount = $('file-viewer-search-count');
  const fileViewerResize = $('file-viewer-resize');
  const projectNameEl = $('project-name');
  const historyPanel = $('history-panel');

  let totalMsgs = 0;
  const state = {
    runs: [],
    selectedRunId: null,
    ghostRunId: null,
    agents: new Map(),
    messages: new Map(),
    seenMsgIds: new Set(),
    unreadCounts: new Map(),
    managerActivity: new Map(),
  };
  let _selectToken = 0;

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

  fetch('/info')
    .then(r => r.json())
    .then(info => {
      if (info.projectName) {
        projectNameEl.textContent = info.projectName;
        projectNameEl.dataset.uiSession = info.uiSession ?? '';
        projectNameEl.dataset.uiWindow  = info.uiWindow  ?? '';
      }
    })
    .catch(() => {});

  projectNameEl.addEventListener('click', () => {
    const session = projectNameEl.dataset.uiSession;
    const win     = projectNameEl.dataset.uiWindow;
    if (!session || !win) return;
    fetch('/focus-agent', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ session, window: win }),
    }).catch(() => {});
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

  const HIGHLIGHT_RE = /(`[^`]+`|(?:[\w./-]+\/[\w./-]+(?:\.[\w]+)?|[\w.-]+\.(?:md|ts|tsx|js|jsx|json|yml|yaml|sql|sh|css|html|toml|env|txt))|--[\w-]+(?:=\S+)?|\b\d+(?:\.\d+)?\s*(?:KB|MB|GB|ms|s|px|%)\b)/g;

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

  const FILE_EXTS = /\.(md|ts|tsx|js|jsx|json|yml|yaml|sql|sh|css|html|toml|env|txt)$/i;

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
        const token = code.textContent;
        if (!token.includes(' ') && ((/\//.test(token) && /\.\w+$/.test(token)) || FILE_EXTS.test(token))) {
          code.classList.add('msg-file-link');
          code.dataset.path = token;
        }
        frag.appendChild(code);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      textNode.parentNode.replaceChild(frag, textNode);
    }
    container.querySelectorAll('code:not(.msg-inline-code)').forEach(code => {
      const token = code.textContent.trim();
      if (!token.includes(' ') && ((/\//.test(token) && /\.\w+$/.test(token)) || FILE_EXTS.test(token))) {
        code.classList.add('msg-file-link');
        code.dataset.path = token;
      }
    });
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

  // Area 6: extract file links into a chip row when there are 3+ distinct paths
  function maybeExtractFilesRow(msgBodyEl, contentEl) {
    const links = Array.from(contentEl.querySelectorAll('code.msg-file-link'));
    const seen = new Set();
    const unique = links.filter(c => {
      if (seen.has(c.dataset.path)) return false;
      seen.add(c.dataset.path);
      return true;
    });
    if (unique.length < 3) return;
    // Replace inline links with plain code
    links.forEach(c => {
      const plain = document.createElement('code');
      plain.className = c.className.replace('msg-file-link', '').trim();
      plain.textContent = c.textContent;
      c.replaceWith(plain);
    });
    // Build chip row
    const row = document.createElement('div');
    row.className = 'files-touched';
    const lbl = document.createElement('span');
    lbl.className = 'files-touched-label';
    lbl.textContent = 'Files:';
    row.appendChild(lbl);
    for (const link of unique) {
      const chip = document.createElement('code');
      chip.className = 'msg-file-link files-touched-chip';
      chip.dataset.path = link.dataset.path;
      chip.textContent = link.dataset.path;
      row.appendChild(chip);
    }
    msgBodyEl.appendChild(row);
  }

  // Area 5: attach show-more toggle to tall message rows
  function maybeAddExpandToggle(div, contentEl) {
    // Use rAF so the element is in the DOM and has layout
    requestAnimationFrame(() => {
      if (contentEl.scrollHeight > 200) {
        div.classList.add('msg-collapsed');
        const btn = document.createElement('button');
        btn.className = 'msg-expand-btn';
        btn.textContent = 'show more';
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const collapsed = div.classList.toggle('msg-collapsed');
          btn.textContent = collapsed ? 'show more' : 'show less';
        });
        div.querySelector('.message-body').appendChild(btn);
      }
    });
  }

  // Type icons for area 4
  const TYPE_ICONS = { TASK: '↳', QUESTION: '?', REPLY: '✓' };

  function buildMessageRow(msg, allMsgs) {
    console.log('[buildMessageRow] id=' + msg.id + ' type=' + JSON.stringify(msg.type) + ' from=' + msg.from_agent + ' to=' + msg.to_agent);
    const isHuman = msg.from_agent === 'operator';
    const direction = isHuman ? 'from-human' : 'from-agent';
    const sender = msg.from_agent;
    const avi = initials(sender);
    const t = (msg.type || '').toUpperCase();
    const typeBadge = t ? '<span class="msg-type-badge msg-type-' + esc(t) + '">' + esc(t) + '</span>' : '';
    const typeIcon = (!isHuman && TYPE_ICONS[t])
      ? '<span class="msg-type-icon">' + esc(TYPE_ICONS[t]) + '</span>' : '';
    const route = isHuman
      ? esc(msg.to_agent)
      : esc(msg.from_agent) + ' <span style="color:var(--muted)">→</span> ' + esc(msg.to_agent);

    const div = document.createElement('div');
    div.className = 'message-row ' + direction;
    div.dataset.msgId = msg.id;
    div.dataset.msgType = t;  // Area 4: for CSS left-accent

    const useHighlight = t === 'REPLY' || (!isHuman && t === 'TASK');
    div.innerHTML =
      '<div class="message-avatar">' + esc(avi) + '</div>' +
      '<div class="message-body">' +
        '<div class="message-header">' +
          typeIcon +
          '<span class="message-sender">' + route + '</span>' +
          typeBadge +
          '<span class="message-time">' + esc(fmtTime(msg.created_at || '')) + '</span>' +
          '<span class="msg-id-label">#' + msg.id + '</span>' +
        '</div>' +
        (useHighlight ? '' : renderMd(msg.body || '')) +
      '</div>';

    let contentEl;
    if (useHighlight) {
      contentEl = renderMdHighlighted(msg.body || '');
      div.querySelector('.message-body').appendChild(contentEl);
    } else {
      contentEl = div.querySelector('.message-content');
      autoHighlight(div.querySelector('.message-body'));
    }

    // Suppress operator REPLY rows that answer a QUESTION — answer is shown on the card.
    if (t === 'REPLY' && msg.from_agent === 'operator' && msg.ref_id) {
      const isQuestionAnswer = (allMsgs || []).some(
        m => m.id === msg.ref_id && m.type === 'QUESTION'
      );
      if (isQuestionAnswer) return null;
    }

    // Render interactive question card for QUESTION messages to operator
    if (t === 'QUESTION' && msg.to_agent === 'operator') {
      const reply = (allMsgs || []).find(
        m => m.ref_id === msg.id && m.from_agent === 'operator',
      );
      if (reply) {
        const resolvedDiv = document.createElement('div');
        resolvedDiv.className = 'question-resolved';
        resolvedDiv.textContent = '✓ ' + (reply.body ? reply.body.trim() : 'answered');
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

    // Area 6: files chip row (not for QUESTION — those need inline interactivity)
    if (contentEl && t !== 'QUESTION') {
      maybeExtractFilesRow(div.querySelector('.message-body'), contentEl);
    }

    // Area 5: collapse long non-QUESTION messages
    if (contentEl && t !== 'QUESTION') {
      maybeAddExpandToggle(div, contentEl);
    }

    return div;
  }

  function buildQuestionCard(msg) {
    const card = document.createElement('div');
    card.className = 'question-card';
    card.dataset.msgId = msg.id;

    let options = [];
    if (msg.options) {
      try { options = JSON.parse(msg.options); } catch {}
    }

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
      const otherBtn = document.createElement('button');
      otherBtn.className = 'question-opt-btn question-opt-other';
      otherBtn.textContent = 'Chat about this';
      otherBtn.addEventListener('click', () => {
        const inp = card.querySelector('.question-input');
        const cmp = card.querySelector('.question-compose');
        if (cmp) cmp.style.display = '';
        if (inp) { inp.focus(); inp.select(); }
      });
      optDiv.appendChild(otherBtn);
      card.appendChild(optDiv);
    }

    const compose = document.createElement('div');
    compose.className = 'question-compose';
    // Always start hidden — options are required server-side, so the only
    // way to reveal free text is clicking "Chat about this" above.
    compose.style.display = 'none';
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

  function findPendingQuestion() {
    const runId = state.selectedRunId;
    if (runId === null) return null;
    const run = state.runs.find(r => r.id === runId);
    if (run && run.status !== 'running') return null;
    const msgs = state.messages.get(runId) || [];
    for (let i = 0; i < msgs.length; i++) {
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
      const row = msgList.querySelector('.message-row[data-msg-id="' + pending.id + '"]');
      if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  async function submitQuestionReply(msg, replyText, card) {
    if (!replyText || !replyText.trim()) return;
    const runId = msg.run_id || state.selectedRunId;
    const msgs = state.messages.get(runId) || [];
    if (msgs.some(m => m.ref_id === msg.id && m.from_agent === 'operator')) return;
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
        const resolvedDiv = document.createElement('div');
        resolvedDiv.className = 'question-resolved';
        resolvedDiv.textContent = '✓ ' + replyText.trim();
        const row = msgList.querySelector('.message-row[data-msg-id="' + msg.id + '"]');
        if (row) {
          const inlineCard = row.querySelector('.question-card:not([data-resolved])');
          if (inlineCard) inlineCard.replaceWith(resolvedDiv);
        }
        if (card && card !== null) {
          card.replaceWith(resolvedDiv.cloneNode(true));
        }
      } else {
        if (card) {
          card.querySelectorAll('button').forEach(b => { b.disabled = false; });
          const input = card.querySelector('.question-input');
          if (input) input.disabled = false;
        }
        flash((json.error || 'reply failed'), false);
      }
    } catch (err) {
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
    if ((item.body || '').length > 80 && !div.querySelector('code.msg-file-link')) {
      div.classList.add('activity-collapsed');
      div.style.cursor = 'pointer';
      div.addEventListener('click', (e) => {
        if (e.target.closest('code.msg-file-link')) return;
        div.classList.toggle('activity-collapsed');
      });
    }
    return div;
  }

  function appendMessage(msg) {
    console.log('[appendMessage] id=' + msg.id + ' type=' + JSON.stringify(msg.type) + ' to=' + msg.to_agent);
    const empty = $('empty-msgs');
    if (empty) empty.remove();
    if (msg.type === 'PROGRESS') {
      console.log('[appendMessage] PROGRESS branch taken for id=' + msg.id);
      msgList.appendChild(buildActivityMarker(msg));
      msgList.scrollTop = msgList.scrollHeight;
      syncComposeMode();
      return;
    }
    if (msg.type === 'REPLY' && msg.from_agent === 'operator' && msg.ref_id) {
      const refRow = msgList.querySelector('.message-row[data-msg-id="' + msg.ref_id + '"]');
      const card = refRow && refRow.querySelector('.question-card:not([data-resolved])');
      if (card) {
        const resolvedDiv = document.createElement('div');
        resolvedDiv.className = 'question-resolved';
        resolvedDiv.textContent = '✓ ' + (msg.body ? msg.body.trim() : 'answered');
        card.replaceWith(resolvedDiv);
        msgList.scrollTop = msgList.scrollHeight;
        syncComposeMode();
        return;
      }
    }
    totalMsgs++;
    const allMsgs = state.messages.get(msg.run_id) || [msg];
    const row = buildMessageRow(msg, allMsgs);
    if (row) msgList.appendChild(row);
    msgList.scrollTop = msgList.scrollHeight;
    syncComposeMode();
  }

  function renderThread() {
    const runId = state.selectedRunId;
    const msgs = (runId !== null ? state.messages.get(runId) : null) || [];
    const activity = (runId !== null ? state.managerActivity.get(runId) : null) || [];
    renderMessages(msgs, activity);
  }

  function renderMessages(msgs, activity) {
    console.log('[renderMessages] msgs=' + msgs.length + ' activity=' + (activity||[]).length);
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
      return;
    }
    for (const item of combined) {
      const empty = $('empty-msgs');
      if (empty) empty.remove();
      if (item._kind === 'msg') {
        if (item.data.type === 'PROGRESS') {
          console.log('[renderMessages] PROGRESS branch taken for id=' + item.data.id);
          msgList.appendChild(buildActivityMarker(item.data));
        } else {
          const isQuestionAnswer = item.data.type === 'REPLY' &&
            item.data.from_agent === 'operator' &&
            item.data.ref_id &&
            msgs.some(m => m.id === item.data.ref_id && m.type === 'QUESTION');
          if (!isQuestionAnswer) {
            const row = buildMessageRow(item.data, msgs);
            if (row) {
              msgList.appendChild(row);
              totalMsgs++;
            }
          }
        }
      } else {
        msgList.appendChild(buildActivityMarker(item.data));
      }
    }
    msgList.scrollTop = msgList.scrollHeight;
    syncComposeMode();
  }

  // Area 3: agent strip with avatar rings
  function renderAgentsStrip(agents) {
    const strip = $('agents-strip');
    if (!strip) return;
    // Keep the label, clear the rest
    const label = strip.querySelector('.agents-strip-label');
    strip.innerHTML = '';
    if (label) strip.appendChild(label);

    if (!agents || !agents.length) {
      const empty = document.createElement('span');
      empty.className = 'agents-empty';
      empty.textContent = 'no agents';
      strip.appendChild(empty);
      return;
    }
    const run = state.runs.find(r => r.id === state.selectedRunId);
    for (const a of agents) {
      const st = (a.status || 'unknown').toLowerCase();
      const dotState = ['idle','busy','stopped'].includes(st) ? st : 'unknown';
      const chip = document.createElement('span');
      chip.className = 'agent-chip';
      chip.dataset.window = a.window_name;
      chip.title = a.window_name + ' · ' + st;

      const avatar = document.createElement('span');
      avatar.className = 'agent-avatar';
      avatar.dataset.state = dotState;
      avatar.textContent = initials(a.window_name);
      chip.appendChild(avatar);

      if (a.pending_count > 0) {
        const badge = document.createElement('span');
        badge.className = 'agent-pending';
        badge.textContent = a.pending_count;
        chip.appendChild(badge);
      }

      if (run) {
        chip.addEventListener('click', () => {
          fetch('/focus-agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session: run.session, window: chip.dataset.window }),
          });
        });
      }
      strip.appendChild(chip);
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

  // Area 1: history panel toggle
  function closeHistoryPanel() {
    if (historyPanel) historyPanel.classList.remove('open');
  }

  function renderHistoryPanel() {
    if (!historyPanel) return;
    const historical = state.runs.filter(r => r.status !== 'running');
    if (!historical.length) { historyPanel.innerHTML = ''; return; }

    const groups = {};
    for (const run of historical) {
      const s = run.status || 'unknown';
      if (!groups[s]) groups[s] = [];
      groups[s].push(run);
    }
    historyPanel.innerHTML = '';
    for (const [status, runs] of Object.entries(groups)) {
      const lbl = document.createElement('div');
      lbl.className = 'history-group-label';
      lbl.textContent = status;
      historyPanel.appendChild(lbl);
      for (const run of runs) {
        const item = document.createElement('div');
        item.className = 'history-run-item' + (run.id === state.selectedRunId ? ' selected' : '');
        item.dataset.runId = run.id;
        const dot = document.createElement('span');
        dot.className = 'run-dot';
        dot.dataset.state = 'done';
        item.appendChild(dot);
        const name = document.createElement('span');
        name.textContent = 'run-' + run.id;
        item.appendChild(name);
        item.addEventListener('click', () => {
          closeHistoryPanel();
          state.ghostRunId = run.id;
          selectRun(run.id);
        });
        historyPanel.appendChild(item);
      }
    }
  }

  const landingEl = $('history-landing');
  const threadHeaderEl = $('thread-header');
  const messagesListEl = $('messages-list');
  const sessionActionsEl = $('session-actions');
  const composeEl = $('compose');

  function renderHistoryLanding() {
    if (!landingEl) return;
    landingEl.innerHTML = '';
    const h2 = document.createElement('h2');
    h2.textContent = 'Run History';
    landingEl.appendChild(h2);
    const sorted = [...state.runs].sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
    if (sorted.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No runs yet.';
      landingEl.appendChild(empty);
      return;
    }
    sorted.forEach(run => {
      const item = document.createElement('div');
      item.className = 'history-landing-item';
      const nameEl = document.createElement('span');
      nameEl.className = 'hl-name';
      nameEl.textContent = run.name || ('run-' + run.id);
      const dateEl = document.createElement('span');
      dateEl.className = 'hl-date';
      dateEl.textContent = run.started_at ? run.started_at.slice(0, 16).replace('T', ' ') : '';
      const goalEl = document.createElement('span');
      goalEl.className = 'hl-goal';
      const goalText = run.goal || '';
      goalEl.textContent = goalText.length > 80 ? goalText.slice(0, 80) + '…' : goalText;
      goalEl.title = goalText;
      const statusEl = document.createElement('span');
      statusEl.className = 'hl-status';
      statusEl.textContent = run.status || '';
      item.append(nameEl, dateEl, goalEl, statusEl);
      item.addEventListener('click', () => {
        state.ghostRunId = run.id;
        selectRun(run.id);
      });
      landingEl.appendChild(item);
    });
  }

  function showLanding() {
    renderHistoryLanding();
    if (landingEl) landingEl.style.display = 'flex';
    if (threadHeaderEl) threadHeaderEl.style.display = 'none';
    if (messagesListEl) messagesListEl.style.display = 'none';
    if (sessionActionsEl) sessionActionsEl.style.display = 'none';
    if (composeEl) composeEl.style.display = 'none';
  }

  function hideLanding() {
    if (landingEl) landingEl.style.display = 'none';
    if (threadHeaderEl) threadHeaderEl.style.display = '';
    if (messagesListEl) messagesListEl.style.display = '';
    if (sessionActionsEl) sessionActionsEl.style.display = '';
    if (composeEl) composeEl.style.display = '';
  }

  // Show landing immediately on page load; hideLanding() is called by selectRun()
  showLanding();

  // Area 1 + 2: render tabs (running only) + history toggle + status labels
  function closeGhostTab() {
    state.ghostRunId = null;
    const firstRunning = state.runs.find(r => r.status === 'running');
    if (firstRunning) {
      selectRun(firstRunning.id);
    } else {
      state.selectedRunId = null;
      renderRunsTabs();
      showLanding();
    }
  }

  function renderRunsTabs() {
    const tabsEl = $('runs-tabs');
    if (!tabsEl) return;
    tabsEl.innerHTML = '';

    const runningRuns = state.runs.filter(r => r.status === 'running');
    const historicalRuns = state.runs.filter(r => r.status !== 'running');
    // Ghost tab: pinned historical run, persists until ✕ is clicked
    const ghostRun = state.ghostRunId
      ? state.runs.find(r => r.id === state.ghostRunId && r.status !== 'running')
      : null;

    for (const run of runningRuns) {
      tabsEl.appendChild(buildRunTab(run, false));
    }
    if (ghostRun) {
      tabsEl.appendChild(buildRunTab(ghostRun, true));
    }

    // Spacer pushes history + new-run to the right
    const spacer = document.createElement('span');
    spacer.className = 'tabs-spacer';
    tabsEl.appendChild(spacer);

    // History toggle
    if (historicalRuns.length > 0) {
      const histBtn = document.createElement('button');
      histBtn.id = 'history-toggle-btn';
      histBtn.textContent = 'History ▾';
      histBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        renderHistoryPanel();
        historyPanel.classList.toggle('open');
      });
      tabsEl.appendChild(histBtn);
    }

    // New run button
    const newBtn = document.createElement('button');
    newBtn.id = 'new-run-btn';
    newBtn.className = 'new-run-btn';
    newBtn.title = 'Start a new run';
    newBtn.textContent = '+';
    newBtn.addEventListener('click', () => {
      startPanel.classList.toggle('open');
      if (startPanel.classList.contains('open')) startGoal.focus();
    });
    tabsEl.appendChild(newBtn);
  }

  function buildRunTab(run, isGhost) {
    const isSelected = run.id === state.selectedRunId;
    const isRunning = run.status === 'running';
    const unread = !isSelected && (state.unreadCounts.get(run.id) || 0);

    // Area 2: status label
    let statusLabel;
    if (isRunning) {
      statusLabel = runHasBusyAgent(run.id) ? 'Busy' : 'Idle';
    } else {
      statusLabel = run.status;
    }

    // Area 2: tooltip
    const agentCount = (state.agents.get(run.id) || []).length;
    const tooltipText = 'run-' + run.id + ' · ' + (run.session || '') + ' · ' + (run.status || '') + ' · ' + agentCount + ' agents';

    const tab = document.createElement('button');
    tab.className = 'run-tab' + (isSelected ? ' selected' : '');
    tab.dataset.runId = run.id;
    tab.title = tooltipText;
    if (isGhost) tab.dataset.history = 'true';

    const dotState = !isRunning ? 'done' : runHasBusyAgent(run.id) ? 'running' : 'standby';
    const dot = document.createElement('span');
    dot.className = 'run-dot';
    dot.dataset.state = dotState;
    tab.appendChild(dot);

    const label = document.createElement('span');
    label.textContent = 'run-' + run.id;
    tab.appendChild(label);

    if (unread) {
      const badge = document.createElement('span');
      badge.className = 'run-unread';
      badge.textContent = unread;
      tab.appendChild(badge);
    }

    if (isGhost) {
      const closeBtn = document.createElement('span');
      closeBtn.className = 'run-tab-close';
      closeBtn.textContent = '✕';
      closeBtn.title = 'Close';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeGhostTab();
      });
      tab.appendChild(closeBtn);
    }

    tab.addEventListener('click', () => {
      closeHistoryPanel();
      selectRun(run.id);
    });
    return tab;
  }

  function updateThreadHeader(run) {
    const titleEl = $('thread-title');
    if (!titleEl || !run) return;
    titleEl.innerHTML = run.goal ? '' : '<span>Thread</span>';
    const goalEl = $('thread-goal');
    const sepEl  = $('thread-sep');
    if (goalEl) goalEl.textContent = run.goal ? run.goal.slice(0, 80) : '';
    if (sepEl)  sepEl.style.display = 'none';
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
    sessionStorage.setItem('synapse-selected-run', String(runId));
    state.unreadCounts.delete(runId);
    renderRunsTabs();
    hideLanding();

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
        if (token !== _selectToken) return;
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
    const prevRunIds = new Set(state.runs.map(r => r.id));
    state.runs = payload.runs || [];
    renderRunsTabs();

    // Auto-select a brand-new running run (prevRunIds.size > 0 guards against
    // the initial page-load case where every run looks "new")
    const newRunning = prevRunIds.size > 0
      ? state.runs.find(r => r.status === 'running' && !prevRunIds.has(r.id))
      : null;
    if (newRunning) {
      selectRun(newRunning.id);
      return;
    }

    if (state.selectedRunId === null && state.runs.length > 0) {
      const firstRunning = state.runs.find(r => r.status === 'running');
      const savedId = Number(sessionStorage.getItem('synapse-selected-run'));
      const savedRun = savedId ? state.runs.find(r => r.id === savedId) : null;
      selectRun((savedRun || firstRunning || state.ghostRunId && state.runs.find(r => r.id === state.ghostRunId) || state.runs[0]).id);
    } else if (state.selectedRunId === null && state.runs.length === 0) {
      showLanding();
    } else if (state.selectedRunId !== null && !state.runs.some(r => r.id === state.selectedRunId) && state.runs.length > 0) {
      selectRun(state.runs[0].id);
    } else if (state.selectedRunId !== null) {
      const run = state.runs.find(r => r.id === state.selectedRunId);
      if (run) {
        updateThreadHeader(run);
        updateKillSessionButton(run);
      }
      syncComposeMode();
    }
  }

  function setConnected(ok) {
    connStatus.className = ok ? 'connected' : 'disconnected';
    connStatus.textContent = ok ? '● live' : '● reconnecting';
    header.classList.toggle('disconnected', !ok);
  }

  // Close history panel on outside click
  document.addEventListener('click', (e) => {
    if (historyPanel && historyPanel.classList.contains('open')) {
      if (!historyPanel.contains(e.target) && !e.target.closest('#history-toggle-btn')) {
        closeHistoryPanel();
      }
    }
  });

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
          renderRunsTabs();
        } else {
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
          state.messages.set(run.id, messages);
          messages.forEach(m => state.seenMsgIds.add(m.id));
          state.managerActivity.set(run.id, managerActivity);
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
            renderRunsTabs();
          }
        } else if (msg.status === 'read' && msg.type === 'QUESTION' && msg.to_agent === 'operator') {
          const row = msgList.querySelector('.message-row[data-msg-id="' + msg.id + '"]');
          if (row) {
            const card = row.querySelector('.question-card:not([data-resolved])');
            if (card) {
              const resolvedDiv = document.createElement('div');
              resolvedDiv.className = 'question-resolved';
              resolvedDiv.textContent = '✓ answered';
              card.replaceWith(resolvedDiv);
            }
          }
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

  async function sendDiscussion() {
    const mi = $('msg-input');
    const sb = $('send-btn');
    const rawBody = mi ? mi.value.trim() : '';
    if (!rawBody) { flash('body required', false); return; }
    if (!state.selectedRunId) { flash('no run selected', false); return; }
    const body = '[Discussion — 请表达真实想法，不要立即执行]\n\n' + rawBody;
    if (sb) sb.disabled = true;
    try {
      const res = await fetch('/send', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          to: 'manager',
          type: 'QUESTION',
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
      } else {
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
        if (stopRunBtn) { stopRunBtn.textContent = 'Stop Run'; }
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
    if (!goal) { setStartStatus('goal required', false); startSubmit.disabled = false; return; }
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

  // --- File Viewer ---

  let fvRawContent = '';
  let fvCurrentPath = '';
  let fvSearchMatches = [];
  let fvSearchIndex = 0;

  function fvBreadcrumb(path) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length <= 3) return path;
    return '…/' + parts.slice(-3).join('/');
  }

  function fvDetectLang(path) {
    const ext = path.split('.').pop().toLowerCase();
    const map = {
      js: 'javascript', ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
      py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
      cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c', sh: 'bash', bash: 'bash',
      zsh: 'bash', fish: 'bash', json: 'json', yaml: 'yaml', yml: 'yaml',
      toml: 'ini', html: 'html', css: 'css', scss: 'scss', sql: 'sql',
      xml: 'xml', md: 'markdown', swift: 'swift', kt: 'kotlin',
    };
    return map[ext] || 'plaintext';
  }

  function fvBuildCodeTable(lines, highlightedHtml) {
    const table = document.createElement('div');
    table.className = 'fv-code-table';
    // Split highlighted html by newlines
    const hlLines = highlightedHtml.split('\n');
    // Remove trailing empty line that hljs sometimes adds
    if (hlLines.length > lines.length && hlLines[hlLines.length - 1] === '') hlLines.pop();
    lines.forEach((_, i) => {
      const row = document.createElement('div');
      row.className = 'fv-line';
      row.dataset.line = i + 1;
      const ln = document.createElement('span');
      ln.className = 'fv-ln';
      ln.textContent = i + 1;
      const code = document.createElement('span');
      code.className = 'fv-code';
      code.innerHTML = hlLines[i] !== undefined ? hlLines[i] : '';
      row.appendChild(ln);
      row.appendChild(code);
      table.appendChild(row);
    });
    return table;
  }

  async function openFileViewer(pathWithLine) {
    const colonLine = pathWithLine.match(/:(\d+)$/);
    const filePath  = colonLine ? pathWithLine.slice(0, -colonLine[0].length) : pathWithLine;
    const targetLine = colonLine ? parseInt(colonLine[1], 10) : null;

    fvCurrentPath = filePath;
    fileViewerBreadcrumb.textContent = fvBreadcrumb(filePath);
    fileViewerBreadcrumb.title = filePath;
    fileViewerBody.textContent = 'Loading…';
    fileViewerPanel.classList.add('open');

    const res = await fetch('/file?path=' + encodeURIComponent(filePath));
    if (!res.ok) {
      fileViewerBody.textContent = res.status === 403 ? 'Access denied.' : 'File not found.';
      return;
    }
    const { content } = await res.json();
    fvRawContent = content;
    fvSearchMatches = [];
    fvSearchIndex = 0;
    fileViewerSearch.value = '';
    fileViewerSearchCount.textContent = '';

    fileViewerBody.innerHTML = '';

    const isMd = filePath.endsWith('.md') || filePath.endsWith('.txt');
    if (isMd) {
      const div = document.createElement('div');
      div.className = 'md-rendered';
      div.appendChild(renderMdHighlighted(content));
      fileViewerBody.appendChild(div);
      fileViewerLineCount.textContent = '';
    } else {
      const lines = content.split('\n');
      // Remove trailing empty line from file end
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      fileViewerLineCount.textContent = lines.length + ' lines';

      let hlHtml;
      try {
        const lang = fvDetectLang(filePath);
        if (window.hljs) {
          const result = hljs.highlight(content, { language: lang, ignoreIllegals: true });
          hlHtml = result.value;
        } else {
          hlHtml = content.split('\n').map(l => escHtml(l)).join('\n');
        }
      } catch (e) {
        hlHtml = content.split('\n').map(l => escHtml(l)).join('\n');
      }

      const table = fvBuildCodeTable(lines, hlHtml);
      fileViewerBody.appendChild(table);

      if (targetLine) {
        const row = table.querySelector(`[data-line="${targetLine}"]`);
        if (row) {
          row.scrollIntoView({ block: 'center' });
          row.classList.add('line-highlight');
          row.addEventListener('animationend', () => row.classList.remove('line-highlight'), { once: true });
        }
      }
    }
  }

  function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Wrap toggle
  let fvWrapped = false;
  fileViewerWrapToggle.addEventListener('click', () => {
    fvWrapped = !fvWrapped;
    fileViewerBody.classList.toggle('wrap-mode', fvWrapped);
    fileViewerWrapToggle.textContent = fvWrapped ? 'Wrap' : 'No wrap';
  });

  // Copy button
  fileViewerCopy.addEventListener('click', () => {
    navigator.clipboard.writeText(fvRawContent).then(() => {
      const orig = fileViewerCopy.textContent;
      fileViewerCopy.textContent = 'Copied!';
      setTimeout(() => { fileViewerCopy.textContent = orig; }, 1500);
    });
  });

  // Maximize toggle
  fileViewerMaximize.addEventListener('click', () => {
    fileViewerPanel.classList.toggle('maximized');
  });

  // In-file search
  function fvClearSearch() {
    fileViewerBody.querySelectorAll('.search-match').forEach(el => {
      el.replaceWith(document.createTextNode(el.textContent));
    });
    fileViewerBody.normalize();
    fvSearchMatches = [];
    fvSearchIndex = 0;
    fileViewerSearchCount.textContent = '';
  }

  function fvRunSearch(query) {
    fvClearSearch();
    if (!query) return;

    const walker = document.createTreeWalker(fileViewerBody, NodeFilter.SHOW_TEXT);
    const ranges = [];
    let node;
    const ql = query.toLowerCase();
    while ((node = walker.nextNode())) {
      const text = node.textContent;
      const tl = text.toLowerCase();
      let idx = 0;
      while ((idx = tl.indexOf(ql, idx)) !== -1) {
        ranges.push({ node, start: idx, end: idx + query.length });
        idx += query.length;
      }
    }

    // Apply marks in reverse order per node to avoid offset shifts
    const byNode = new Map();
    ranges.forEach(r => {
      if (!byNode.has(r.node)) byNode.set(r.node, []);
      byNode.get(r.node).push(r);
    });

    const marks = [];
    byNode.forEach((hits, node) => {
      hits.sort((a, b) => b.start - a.start);
      hits.forEach(({ start, end }) => {
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        const mark = document.createElement('mark');
        mark.className = 'search-match';
        range.surroundContents(mark);
        marks.push(mark);
      });
    });

    fvSearchMatches = Array.from(fileViewerBody.querySelectorAll('.search-match'))
      .sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return ra.top !== rb.top ? ra.top - rb.top : ra.left - rb.left;
      });
    fvSearchIndex = 0;
    fvHighlightCurrentMatch();
    fileViewerSearchCount.textContent = fvSearchMatches.length ? `1 / ${fvSearchMatches.length}` : '0';
  }

  function fvHighlightCurrentMatch() {
    fvSearchMatches.forEach((m, i) => {
      m.classList.toggle('search-current', i === fvSearchIndex);
    });
    if (fvSearchMatches.length) {
      fvSearchMatches[fvSearchIndex].scrollIntoView({ block: 'center' });
      fileViewerSearchCount.textContent = `${fvSearchIndex + 1} / ${fvSearchMatches.length}`;
    }
  }

  let fvSearchTimer = null;
  fileViewerSearch.addEventListener('input', () => {
    clearTimeout(fvSearchTimer);
    fvSearchTimer = setTimeout(() => fvRunSearch(fileViewerSearch.value), 150);
  });

  fileViewerSearch.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!fvSearchMatches.length) return;
      if (e.shiftKey) {
        fvSearchIndex = (fvSearchIndex - 1 + fvSearchMatches.length) % fvSearchMatches.length;
      } else {
        fvSearchIndex = (fvSearchIndex + 1) % fvSearchMatches.length;
      }
      fvHighlightCurrentMatch();
    } else if (e.key === 'Escape') {
      fileViewerSearch.value = '';
      fvClearSearch();
    }
  });

  // Drag-resize
  (function () {
    const savedW = localStorage.getItem('fv-width');
    if (savedW) fileViewerPanel.style.width = savedW;

    let dragging = false, startX, startW;
    fileViewerResize.addEventListener('mousedown', e => {
      dragging = true;
      startX = e.clientX;
      startW = fileViewerPanel.offsetWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const dx = startX - e.clientX;
      const newW = Math.max(280, Math.min(window.innerWidth * 0.9, startW + dx));
      fileViewerPanel.style.width = newW + 'px';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (!fileViewerPanel.classList.contains('maximized')) {
        localStorage.setItem('fv-width', fileViewerPanel.style.width);
      }
    });
  })();

  document.addEventListener('click', async (e) => {
    const link = e.target.closest('code.msg-file-link');
    if (!link) return;
    e.stopPropagation();
    openFileViewer(link.dataset.path).catch(() => {
      fileViewerBody.textContent = 'Error loading file.';
    });
  });

  fileViewerClose.addEventListener('click', () => {
    fileViewerPanel.classList.remove('open');
  });

  fileViewerOpenExt.addEventListener('click', () => {
    fetch('/open-file', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ path: fvCurrentPath })
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && fileViewerPanel.classList.contains('open')) {
      if (document.activeElement === fileViewerSearch) {
        fileViewerSearch.value = '';
        fvClearSearch();
        fileViewerSearch.blur();
      } else {
        fileViewerPanel.classList.remove('open');
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'f' && fileViewerPanel.classList.contains('open')) {
      e.preventDefault();
      fileViewerSearch.focus();
      fileViewerSearch.select();
    }
  });

  startCancel.addEventListener('click', () => {
    startPanel.classList.remove('open');
    setStartStatus('', true);
  });
  startSubmit.addEventListener('click', startRun);
  sendBtn.addEventListener('click', sendMessage);
  killSessionBtn.addEventListener('click', killSession);
  finishRunBtn.addEventListener('click', finishRun);
  if (stopRunBtn) stopRunBtn.addEventListener('click', finishRun);
  msgInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      e.preventDefault(); sendDiscussion();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault(); sendMessage();
    }
    // Shift+Enter: pass through — browser inserts newline
  });
  startGoal.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); startRun(); }
  });
})();
