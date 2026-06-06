  // ── State ────────────────────────────────────────────────────────────────
  let agentStatuses    = [];
  let allMessages      = [];
  let pendingApprovals = [];
  let recentEvents     = [];
  let toolMetrics      = [];
  let allTasks         = [];
  let planContent      = '';
  let selectedAgentId  = null;
  let middlePanelTab   = 'messages'; // 'messages' | 'plan'
  let rightPanelTab    = 'tasks';    // 'events'   | 'tasks'

  // ── Theme ────────────────────────────────────────────────────────────────
  const themeBtn = document.getElementById('theme-btn');
  const bright = localStorage.getItem('sdeck-theme') === 'bright';
  if (bright) document.documentElement.classList.add('bright');
  themeBtn.textContent = bright ? '☾' : '☀';
  themeBtn.addEventListener('click', () => {
    const isBright = document.documentElement.classList.toggle('bright');
    localStorage.setItem('sdeck-theme', isBright ? 'bright' : 'dark');
    themeBtn.textContent = isBright ? '☾' : '☀';
  });

  // ── Activity collapse ──────────────────────────────────────────────────────
  // A stored preference ('collapsed'|'expanded') overrides the responsive default;
  // 'auto' (no/unknown value) lets the @media query decide based on width.
  const mainEl   = document.querySelector('main');
  const NARROW   = () => window.matchMedia('(max-width: 1100px)').matches;
  function applyActivityPref() {
    const pref = localStorage.getItem('sdeck-activity'); // 'collapsed' | 'expanded' | null
    mainEl.classList.toggle('activity-collapsed', pref === 'collapsed');
    mainEl.classList.toggle('activity-expanded',  pref === 'expanded');
  }
  applyActivityPref();
  // Decide the panel's CURRENT visible state from classes + the responsive
  // default, then flip to the opposite by setting an explicit preference.
  function activityVisible() {
    if (mainEl.classList.contains('activity-collapsed')) return false;
    if (mainEl.classList.contains('activity-expanded'))  return true;
    return !NARROW(); // no explicit pref → media query decides
  }
  function toggleActivity() {
    localStorage.setItem('sdeck-activity', activityVisible() ? 'collapsed' : 'expanded');
    applyActivityPref();
  }
  document.getElementById('activity-collapse').addEventListener('click', toggleActivity);
  document.getElementById('activity-expand').addEventListener('click', toggleActivity);

  // ── Project info ──────────────────────────────────────────────────────────
  fetch('/api/info').then(r => r.json()).then(({ project, projectId }) => {
    const label = projectId ? `${project}  ·  ${projectId}` : project;
    document.getElementById('project-name').textContent = label;
    document.title = `S-Deck — ${project}`;
  });

  // ── SSE ──────────────────────────────────────────────────────────────────
  const dot   = document.getElementById('conn-dot');
  const label = document.getElementById('conn-label');

  function connect() {
    const es = new EventSource('/events');

    es.onopen = () => {
      dot.style.background = 'var(--idle)';
      dot.style.boxShadow  = '0 0 6px var(--idle)';
      label.textContent    = 'live';
    };

    es.onmessage = (e) => {
      const { statuses, messages, approvals, events, metrics, tasks, plan } = JSON.parse(e.data);
      agentStatuses    = statuses;
      allMessages      = messages;
      pendingApprovals = approvals ?? [];
      recentEvents     = events ?? [];
      toolMetrics      = metrics ?? [];
      allTasks         = tasks ?? [];
      if (plan !== undefined) planContent = plan.content ?? '';
      renderAgents();
      renderMessages();
      renderApprovals();
      renderActivity();
      if (rightPanelTab === 'tasks') renderTasks();
      if (middlePanelTab === 'plan') renderPlan();
    };

    es.onerror = () => {
      dot.style.background = 'var(--error)';
      dot.style.boxShadow  = 'none';
      label.textContent    = 'disconnected — retrying…';
      es.close();
      setTimeout(connect, 3000);
    };
  }

  connect();

  // ── Render approvals ─────────────────────────────────────────────────────
  const approvalsPanel = document.getElementById('approvals-panel');

  function renderApprovals() {
    if (pendingApprovals.length === 0) {
      approvalsPanel.classList.remove('visible');
      approvalsPanel.innerHTML = '';
      return;
    }
    approvalsPanel.classList.add('visible');
    approvalsPanel.innerHTML = pendingApprovals.map(a => `
      <div class="approval-card" data-approval-id="${a.id}">
        <div class="approval-question">⚠ ${esc(a.question)}</div>
        ${a.context ? `<div class="approval-context">${esc(a.context)}</div>` : ''}
        <div class="approval-meta">from ${esc(a.agent_id)} · ${new Date(a.created_at).toLocaleTimeString()}</div>
        <div class="approval-actions">
          <input class="approval-comment" type="text" placeholder="Optional comment…" />
          <button class="btn-approve" data-id="${a.id}">Approve</button>
          <button class="btn-reject" data-id="${a.id}">Reject</button>
        </div>
      </div>
    `).join('');

    approvalsPanel.querySelectorAll('.btn-approve, .btn-reject').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const status = btn.classList.contains('btn-approve') ? 'approved' : 'rejected';
        const comment = btn.closest('.approval-card').querySelector('.approval-comment').value.trim() || null;
        await fetch(`/api/approvals/${id}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status, comment }),
        });
      });
    });
  }

  // ── Render agents ─────────────────────────────────────────────────────────
  const agentsList = document.getElementById('agents-list');

  function timeAgo(ts) {
    const secs = Math.floor((Date.now() - ts) / 1000);
    if (secs < 5)   return 'just now';
    if (secs < 60)  return `${secs}s ago`;
    if (secs < 3600) return `${Math.floor(secs/60)}m ago`;
    return `${Math.floor(secs/3600)}h ago`;
  }

  function renderAgents() {
    if (agentStatuses.length === 0) {
      agentsList.innerHTML = '<div class="empty-state">No agents connected yet.</div>';
      return;
    }

    // Auto-select first agent if none selected
    if (!selectedAgentId && agentStatuses.length > 0) {
      selectedAgentId = agentStatuses[0].agent_id;
      // Initial load: ensure the freshly-selected agent's messages start at the bottom.
      requestAnimationFrame(scrollMessagesToBottom);
    }

    agentsList.innerHTML = agentStatuses.map(a => {
      const selected = a.agent_id === selectedAgentId;
      const cardClass = ['agent-card', selected ? 'selected' : ''].filter(Boolean).join(' ');
      const slot = `:${a.slot}`;
      const humanName = a.name && a.name !== a.agent_id ? esc(a.name) : '';
      const hasTmux = !!a.tmux_pane;
      const stateColor = { idle: 'var(--idle)', working: 'var(--working)', blocked: 'var(--blocked)', error: 'var(--error)' }[a.state] ?? 'var(--muted)';
      const isOrch = a.slot === 0;
      return `
        <div class="${cardClass}" data-agent-id="${esc(a.agent_id)}" title="click to select">
          <div class="agent-card-row">
            <div class="agent-name">${esc(slot)}${humanName ? `  <span style="color:var(--muted);font-weight:400;">${humanName}</span>` : ''}</div>
            <div style="display:flex;align-items:center;gap:6px;">
              <button class="surface-btn focus-btn" data-focus-id="${esc(a.agent_id)}" ${hasTmux ? '' : 'disabled'} title="${hasTmux ? 'Focus tmux pane' : 'No tmux pane'}">focus</button>
              <button class="surface-btn ping-btn" data-ping-id="${esc(a.agent_id)}" ${hasTmux ? '' : 'disabled'} title="${hasTmux ? 'Nudge agent' : 'No tmux pane'}">ping</button>
              <div class="agent-menu-wrap">
                <button class="kebab-btn" data-menu-id="${esc(a.agent_id)}" title="More actions">⋮</button>
                <div class="agent-menu" id="menu-${esc(a.agent_id)}" style="display:none;">
                  <button class="cfg-item" data-cfg-id="${esc(a.agent_id)}">cfg</button>
                  ${!isOrch ? `<button class="restart-item danger" data-restart-id="${esc(a.agent_id)}" data-restart-slot="${a.slot}" ${hasTmux ? '' : 'disabled'}>restart</button>` : ''}
                  ${!isOrch ? `<button class="kill-item danger" data-kill-id="${esc(a.agent_id)}" data-kill-slot="${a.slot}" ${hasTmux ? '' : 'disabled'} style="color:var(--error);">kill</button>` : ''}
                </div>
              </div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;margin-top:5px;">
            <span style="width:7px;height:7px;border-radius:50%;background:${stateColor};flex-shrink:0;"></span>
            <span style="font-size:11px;color:${stateColor};font-weight:600;">${esc(a.state)}</span>
          </div>
          ${renderMetricChips(a.agent_id)}
        </div>
      `;
    }).join('');

    // Close all open menus when clicking outside
    function closeAllMenus() {
      agentsList.querySelectorAll('.agent-menu').forEach(m => { m.style.display = 'none'; });
    }

    // Wire card click → select agent (original behavior)
    agentsList.querySelectorAll('.agent-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.agent-menu-wrap') || e.target.closest('.focus-btn') || e.target.closest('.ping-btn')) return;
        closeAllMenus();
        selectedAgentId = card.dataset.agentId;
        renderAgents();
        renderMessages();
        renderActivity();
        if (rightPanelTab === 'tasks') renderTasks();
        // Agent switch: leave the scroll position as-is — do not force to bottom.
      });
    });

    // Wire kebab button → toggle menu
    agentsList.querySelectorAll('.kebab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const agentId = btn.dataset.menuId;
        const menu = document.getElementById(`menu-${agentId}`);
        const isOpen = menu.style.display !== 'none';
        closeAllMenus();
        if (!isOpen) menu.style.display = 'block';
      });
    });

    // Close menus when clicking outside the agents list
    document.addEventListener('click', closeAllMenus, { capture: false });

    // Wire focus surface button
    agentsList.querySelectorAll('.focus-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const agentId = btn.dataset.focusId;
        const card = btn.closest('.agent-card');
        btn.disabled = true;
        btn.textContent = '…';
        await fetch(`/api/focus/${encodeURIComponent(agentId)}`, { method: 'POST' });
        if (card) {
          card.style.boxShadow = 'inset 3px 0 0 var(--accent), 0 0 0 1px var(--accent)';
          setTimeout(() => { card.style.boxShadow = ''; }, 400);
        }
        setTimeout(() => { btn.disabled = false; btn.textContent = 'focus'; }, 1000);
      });
    });

    // Wire ping surface button
    agentsList.querySelectorAll('.ping-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const agentId = btn.dataset.pingId;
        btn.disabled = true;
        btn.textContent = '…';
        await fetch(`/api/ping/${encodeURIComponent(agentId)}`, { method: 'POST' });
        setTimeout(() => { btn.disabled = false; btn.textContent = 'ping'; }, 1500);
      });
    });

    // Wire cfg menu item → open config dialog
    agentsList.querySelectorAll('.cfg-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeAllMenus();
        openAgentConfigDialog(btn.dataset.cfgId);
      });
    });

    // Wire restart menu item
    agentsList.querySelectorAll('.restart-item').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeAllMenus();
        const agentId = btn.dataset.restartId;
        const agentSlot = btn.dataset.restartSlot;
        if (!confirm(`Restart :${agentSlot}? This kills the tmux pane and spawns a fresh worker with the same role.`)) return;
        btn.disabled = true;
        btn.textContent = 'restarting…';
        try {
          const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/restart`, { method: 'POST' });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? 'failed');
          // SSE will refresh the agent list automatically — no manual reset needed.
        } catch (err) {
          btn.textContent = `err`;
          setTimeout(() => { btn.disabled = false; btn.textContent = 'restart'; }, 3000);
        }
      });
    });

    // Wire kill menu item
    agentsList.querySelectorAll('.kill-item').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeAllMenus();
        const agentId = btn.dataset.killId;
        const agentSlot = btn.dataset.killSlot;
        if (!confirm(`Kill :${agentSlot}? This terminates the tmux pane permanently — the agent will NOT be respawned.`)) return;
        btn.disabled = true;
        btn.textContent = 'killing…';
        try {
          const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/kill`, { method: 'POST' });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error ?? 'failed');
          // SSE will refresh the agent list automatically.
        } catch (err) {
          btn.textContent = 'err';
          setTimeout(() => { btn.disabled = false; btn.textContent = 'kill'; }, 3000);
        }
      });
    });

    updateComposePlaceholder();
  }

  // ── Tool metric chips (per agent card) ─────────────────────────────────────
  function renderMetricChips(agentId) {
    const rows = toolMetrics.filter(m => m.synapse_agent_id === agentId);
    if (!rows.length) return '';
    const chips = rows.slice(0, 6).map(m => {
      const avg = m.avg_ms != null ? ` ${Math.round(m.avg_ms)}ms` : '';
      const cls = m.errors > 0 ? 'metric-chip has-err' : 'metric-chip';
      const errs = m.errors > 0 ? ` ⚠${m.errors}` : '';
      return `<span class="${cls}" title="${esc(m.tool)}: ${m.calls} calls, ${m.errors} errors${m.avg_ms != null ? ', avg ' + Math.round(m.avg_ms) + 'ms, max ' + Math.round(m.max_ms) + 'ms' : ''}"><b>${esc(m.tool)}</b> ${m.calls}${errs}${avg}</span>`;
    }).join('');
    return `<div class="agent-metrics">${chips}</div>`;
  }

  // ── Render activity feed ───────────────────────────────────────────────────
  const activityList  = document.getElementById('activity-list');
  const activityFlash = document.getElementById('activity-latest-flash');

  function summariseEvent(e) {
    let payload = {};
    try { payload = e.payload ? JSON.parse(e.payload) : {}; } catch {}
    let label;
    if (e.event.startsWith('tool:after:')) {
      label = payload.tool ?? e.event.slice('tool:after:'.length);
    } else if (e.event.startsWith('tool:before:')) {
      label = payload.tool ?? e.event.slice('tool:before:'.length);
    } else {
      label = e.event;
    }
    const detail = payload.input ?? payload.prompt ?? payload.message ?? payload.reason ?? '';
    return detail ? `${label}: ${detail}` : label;
  }

  function renderActivity() {
    // Filter to the selected agent if one is chosen; else show the whole swarm.
    const filtered = selectedAgentId
      ? recentEvents.filter(e => e.synapse_agent_id === selectedAgentId)
      : recentEvents;

    // Ticker mirrors the activity list: same filtered view, newest event (index 0 = newest-first)
    const latestFiltered = filtered[0];
    activityFlash.textContent = latestFiltered ? summariseEvent(latestFiltered) : '';

    let activityInnerHtml;
    if (!filtered.length) {
      activityInnerHtml = '<div class="empty-state">No tool activity yet.</div>';
    } else {
      activityInnerHtml = filtered.map(e => {
        let payload = {};
        try { payload = e.payload ? JSON.parse(e.payload) : {}; } catch {}
        const t = new Date(e.timestamp).toLocaleTimeString([], { hour12: false });

        // tool:after:* → status + duration; tool:before:* → skip (noise); other → generic event
        if (e.event.startsWith('tool:after:')) {
          const tool = payload.tool ?? e.event.slice('tool:after:'.length);
          const ok = (payload.status ?? 'ok') !== 'error';
          const detail = esc(payload.input ?? '');
          const dur = e.duration_ms != null ? `${e.duration_ms}ms` : '';
          return `<div id="evt-${e.id}" class="activity-row ${ok ? 'ok' : 'err'}">
            <span class="activity-time">${t}</span>
            <span class="activity-tool">${esc(tool)}</span>
            <span class="activity-detail">${detail}</span>
            <span class="activity-dur">${dur}</span>
          </div>`;
        }
        if (e.event.startsWith('tool:before:')) return ''; // collapse before-events

        // lifecycle / non-tool events (user:prompt, session:*, agent:stop, subagent:*, context:compact)
        const summary = esc(payload.prompt ?? payload.message ?? payload.reason ?? payload.source ?? payload.trigger ?? payload.stopReason ?? payload.agentType ?? '');
        return `<div id="evt-${e.id}" class="activity-row evt">
          <span class="activity-time">${t}</span>
          <span class="activity-tool">${esc(e.event)}</span>
          <span class="activity-detail">${summary}</span>
        </div>`;
      }).join('');
    }

    morphdom(activityList, `<div id="activity-list">${activityInnerHtml}</div>`, { childrenOnly: true });
  }

  // ── Middle panel tab switching (Messages / Plan) ─────────────────────────
  const tabMessages   = document.getElementById('tab-messages');
  const tabPlan       = document.getElementById('tab-plan');
  const messagesList  = document.getElementById('messages-list');
  const planContentEl = document.getElementById('plan-content');
  const planRendered  = document.getElementById('plan-rendered');
  const composeEl     = document.getElementById('compose');

  function renderPlan() {
    const inner = planContent.trim()
      ? renderMarkdown(planContent)
      : '<div class="empty-state">No PLAN.md found at project root.</div>';
    morphdom(planRendered, `<div id="plan-rendered">${inner}</div>`, { childrenOnly: true });
  }

  function switchMiddleTab(tab) {
    middlePanelTab = tab;
    tabMessages.classList.toggle('active', tab === 'messages');
    tabPlan.classList.toggle('active', tab === 'plan');
    messagesList.style.display = tab === 'messages' ? '' : 'none';
    planContentEl.style.display = tab === 'plan' ? '' : 'none';
    composeEl.style.display = tab === 'messages' ? '' : 'none';
    if (tab === 'plan') renderPlan();
  }

  tabMessages.addEventListener('click', () => switchMiddleTab('messages'));
  tabPlan.addEventListener('click', () => switchMiddleTab('plan'));

  // ── Right panel tab switching ────────────────────────────────────────────
  const tabEvents  = document.getElementById('tab-events');
  const tabTasks   = document.getElementById('tab-tasks');
  const taskList   = document.getElementById('task-list');

  function switchRightTab(tab) {
    rightPanelTab = tab;
    tabEvents.classList.toggle('active', tab === 'events');
    tabTasks.classList.toggle('active', tab === 'tasks');
    activityList.style.display = tab === 'events' ? '' : 'none';
    taskList.style.display = tab === 'tasks' ? '' : 'none';
    if (tab === 'tasks') renderTasks();
  }

  tabEvents.addEventListener('click', () => switchRightTab('events'));
  tabTasks.addEventListener('click', () => switchRightTab('tasks'));

  // ── Tasks rendering ──────────────────────────────────────────────────────
  function renderTasks() {
    const sel = agentStatuses.find(a => a.agent_id === selectedAgentId);
    const isOrchestrator = sel?.slot === 0;
    const filtered = (sel && !isOrchestrator)
      ? allTasks.filter(a => a.agent_id === selectedAgentId)
      : allTasks;

    let html;
    if (!filtered.length) {
      html = '<div class="empty-state">No tasks recorded yet for this agent.</div>';
    } else {
      html = filtered.map(a => {
        const startTime = new Date(a.started_at).toLocaleTimeString([], { hour12: false });
        const endTime = a.finished_at ? new Date(a.finished_at).toLocaleTimeString([], { hour12: false }) : null;
        const duration = a.finished_at ? `${Math.round((a.finished_at - a.started_at) / 1000)}s` : null;
        const sha = a.commit_sha ? `<span class="task-sha" title="commit ${esc(a.commit_sha)}">${esc(a.commit_sha.slice(0, 7))}</span>` : '';
        const timeStr = endTime ? `${startTime} → ${endTime}${duration ? ` (${duration})` : ''}` : `${startTime} …`;
        const jumpId = a.result_msg_id ?? a.trigger_msg_id;
        const clickable = jumpId ? 'clickable' : '';
        const dataJump = jumpId ? `data-jump-msg="${jumpId}"` : '';
        const ownerSlot = agentStatuses.find(s => s.agent_id === a.agent_id)?.slot;
        const slotTag = isOrchestrator && ownerSlot != null
          ? `<span class="activity-slot-tag">:${ownerSlot}</span>`
          : '';
        return `<div class="task-row ${clickable}" id="act-${a.id}" ${dataJump}>
          <div class="task-title">${slotTag}${esc(a.title)}</div>
          <div class="task-meta">
            <span class="task-status ${a.status}">${a.status.replace('_', ' ')}</span>
            <span>${timeStr}</span>
            ${sha}
          </div>
        </div>`;
      }).join('');
    }

    morphdom(taskList, `<div id="task-list">${html}</div>`, { childrenOnly: true });

    // Wire click → jump to linked message
    taskList.querySelectorAll('.task-row.clickable').forEach(row => {
      row.addEventListener('click', () => {
        const msgId = row.dataset.jumpMsg;
        if (!msgId) return;
        const target = document.getElementById(`msg-${msgId}`);
        if (!target) return;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        target.style.outline = '1.5px solid var(--accent)';
        target.style.background = 'rgba(79,126,248,0.08)';
        setTimeout(() => { target.style.outline = ''; target.style.background = ''; }, 1200);
      });
    });
  }

  function updateComposePlaceholder() {
    const agent = agentStatuses.find(a => a.agent_id === selectedAgentId);
    const label = agent ? `:${agent.slot}` : null;
    msgInput.placeholder = label
      ? `Message to ${label}… ⌘↵ send · ⌘⇧↵ urgent`
      : 'Select an agent… ⌘↵ send · ⌘⇧↵ urgent';
    msgInput.disabled = !selectedAgentId;
  }

  // Re-render agents every 5s so timeAgo and stale state stay current
  setInterval(renderAgents, 5_000);

  // ── Render messages ───────────────────────────────────────────────────────

  // Track whether the user has scrolled up to read history. When false (user is
  // at/near the bottom), new messages auto-scroll into view; when true, we leave
  // their reading position alone. Reset to false on initial load and agent switch.
  let userScrolledUp = false;
  messagesList.addEventListener('scroll', () => {
    const nearBottom = messagesList.scrollHeight - messagesList.scrollTop - messagesList.clientHeight < 50;
    userScrolledUp = !nearBottom;
  });

  /** Jump the message list to the bottom and re-enable auto-scroll. */
  function scrollMessagesToBottom() {
    userScrolledUp = false;
    messagesList.scrollTop = messagesList.scrollHeight;
  }

  function renderMessages() {
    const selectedAgent = agentStatuses.find(a => a.agent_id === selectedAgentId);

    const msgs = [...allMessages]
      .filter(m => m.from_id === 'human' || m.to_id === 'human')
      .filter(m => !selectedAgentId || m.from_id === selectedAgentId || m.to_id === selectedAgentId)
      .sort((a, b) => a.created_at - b.created_at);

    let innerHtml;
    if (msgs.length === 0) {
      innerHtml = '<div class="empty-state">No messages for this agent yet.</div>';
    } else {
      innerHtml = msgs.map(m => {
        const isP0      = m.priority === 0;
        const fromHuman = m.from_id === 'human';
        const cls = [isP0 ? 'p0' : '', fromHuman ? 'from-human' : 'from-agent'].filter(Boolean).join(' ');
        const t = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const senderId = fromHuman ? 'human' : m.from_id;
        const agent = agentStatuses.find(a => a.agent_id === senderId);
        const senderLabel = fromHuman ? 'you' : (agent ? `:${agent.slot}${agent.name && agent.name !== agent.agent_id ? ' ' + agent.name : ''}` : senderId);
        const avatarLabel = fromHuman ? 'you' : (agent ? `:${agent.slot}` : senderId.slice(-3));
        const p0badge = isP0 ? ` <span style="font-size:10px;color:var(--p0);font-weight:700;">P0</span>` : '';
        return `
          <div id="msg-${m.id}" class="message-row ${cls}">
            <div class="message-avatar">${esc(avatarLabel)}</div>
            <div class="message-body">
              <div class="message-header">
                ${p0badge}
                <span class="message-time">${t}</span>
              </div>
              <div class="message-content">${renderMarkdown(m.content)}</div>
            </div>
          </div>
        `;
      }).join('');

      if (selectedAgent) {
        const stateColor = { idle: 'var(--idle)', working: 'var(--working)', blocked: 'var(--blocked)', error: 'var(--error)' }[selectedAgent.state] ?? 'var(--muted)';
        const task = selectedAgent.current_task ? esc(selectedAgent.current_task) : '';
        innerHtml += `
          <div id="msg-status-row" style="display:flex;align-items:center;gap:8px;padding:8px 0 2px;opacity:0.6;">
            <div style="flex:1;height:1px;background:var(--border);"></div>
            <span style="display:flex;align-items:center;gap:5px;font-size:10px;color:var(--muted);white-space:nowrap;">
              <span style="width:5px;height:5px;border-radius:50%;background:${stateColor};"></span>
              <span style="color:${stateColor};">${esc(selectedAgent.state)}</span>
              ${task ? `<span>·</span><span>${task}</span>` : ''}
            </span>
            <div style="flex:1;height:1px;background:var(--border);"></div>
          </div>
        `;
      }
    }

    // morphdom diffs children in-place — existing nodes stay put, preserving scroll
    // position, text selection, and preventing markdown re-render blink.
    morphdom(messagesList, `<div id="messages-list">${innerHtml}</div>`, { childrenOnly: true });

    if (!userScrolledUp) messagesList.scrollTop = messagesList.scrollHeight;
  }

  // ── Send message ──────────────────────────────────────────────────────────
  const msgInput = document.getElementById('msg-input');

  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.shiftKey) { e.preventDefault(); send(5); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.shiftKey)  { e.preventDefault(); send(0); }
  });
  // Auto-resize floor/ceiling — floor matches the CSS --msg-input-min (~4 rows).
  const MSG_INPUT_MIN = 92;
  const MSG_INPUT_MAX = 220;
  function autosizeMsgInput() {
    msgInput.style.height = MSG_INPUT_MIN + 'px';
    msgInput.style.height = Math.min(Math.max(msgInput.scrollHeight, MSG_INPUT_MIN), MSG_INPUT_MAX) + 'px';
  }
  msgInput.addEventListener('input', autosizeMsgInput);

  async function send(priority = 5) {
    if (!selectedAgentId) return;
    const content = msgInput.value.trim();

    if (!content) return;

    await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_id: selectedAgentId, content, priority }),
    });

    msgInput.value = '';
    msgInput.style.height = MSG_INPUT_MIN + 'px';
    // Scroll to bottom after send — brings user to their just-sent message and
    // re-enables auto-scroll for subsequent incoming replies.
    requestAnimationFrame(() => scrollMessagesToBottom());
  }

  // ── Tidy ended agents ────────────────────────────────────────────────────
  const purgeBtn = document.getElementById('purge-btn');
  purgeBtn.addEventListener('click', async () => {
    purgeBtn.disabled = true;
    purgeBtn.textContent = '…';
    try {
      const res = await fetch('/api/agents/purge', { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { purged } = await res.json();
      purgeBtn.textContent = purged > 0 ? `purged ${purged}` : 'none';
    } catch (err) {
      purgeBtn.textContent = `error: ${err.message}`;
    }
    setTimeout(() => { purgeBtn.disabled = false; purgeBtn.textContent = 'tidy'; }, 2000);
  });

  // ── Utils ─────────────────────────────────────────────────────────────────
  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Open all rendered links in a new tab safely. Runs on every sanitized node.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  // Render bus message content as GitHub-flavored markdown, then sanitize.
  // marked does NOT sanitize — DOMPurify strips any crafted HTML / javascript: URLs.
  function renderMarkdown(content) {
    const html = marked.parse(String(content ?? ''), { gfm: true, breaks: true });
    return DOMPurify.sanitize(html);
  }

  // ── Agent config dialog ────────────────────────────────────────────────────
  const configBackdrop = document.getElementById('agent-config-backdrop');
  const modalSlot      = document.getElementById('modal-agent-slot');
  const modalModel     = document.getElementById('modal-model');
  const modalEffort    = document.getElementById('modal-effort');
  const modalCancel    = document.getElementById('modal-cancel');
  const modalSave      = document.getElementById('modal-save');

  let configAgentId = null;

  function openAgentConfigDialog(agentId) {
    const agent = agentStatuses.find(a => a.agent_id === agentId);
    if (!agent) return;
    configAgentId = agentId;
    modalSlot.textContent = `:${agent.slot}`;
    modalModel.value  = agent.model  ?? '';
    modalEffort.value = agent.effort ?? '';
    configBackdrop.classList.remove('hidden');
    modalModel.focus();
  }

  function closeConfigDialog() {
    configBackdrop.classList.add('hidden');
    configAgentId = null;
  }

  modalCancel.addEventListener('click', closeConfigDialog);
  configBackdrop.addEventListener('click', (e) => { if (e.target === configBackdrop) closeConfigDialog(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeConfigDialog(); });

  modalSave.addEventListener('click', async () => {
    if (!configAgentId) return;
    const body = {
      model:  modalModel.value  || null,
      effort: modalEffort.value || null,
    };
    modalSave.disabled = true;
    modalSave.textContent = '…';
    await fetch(`/api/agents/${encodeURIComponent(configAgentId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    modalSave.disabled = false;
    modalSave.textContent = 'Save';
    const savedId = configAgentId;
    closeConfigDialog();
    // Reflect the update locally immediately (SSE will confirm later)
    const agent = agentStatuses.find(a => a.agent_id === savedId);
    if (agent) {
      agent.model  = body.model;
      agent.effort = body.effort;
    }
    renderAgents();
  });

  // ── Roles modal ────────────────────────────────────────────────────────────
  const rolesBtn      = document.getElementById('roles-btn');
  const rolesBackdrop = document.getElementById('roles-backdrop');
  const rolesListEl   = document.getElementById('roles-list');
  const rolesNewBtn   = document.getElementById('roles-new-btn');
  const rolesHeader   = document.getElementById('roles-editor-header');
  const rolesSource   = document.getElementById('roles-source');
  const rolesError    = document.getElementById('roles-error');
  const rolesDelete   = document.getElementById('roles-delete');
  const rolesCancel   = document.getElementById('roles-cancel');
  const rolesSave     = document.getElementById('roles-save');

  const NEW_ROLE_TEMPLATE =
`---
role: new-role
description: One-line description here
capabilities: []
---

## Role: New Role

Describe the role's responsibilities here.
`;

  let rolesCache = [];          // [{ name, description, capabilities, body }]
  let rolesSelected = null;     // slug of the role being edited, or null
  let rolesCreating = false;    // true when editing an unsaved new role

  function setRolesError(msg) { rolesError.textContent = msg || ''; }

  function renderRolesList() {
    if (!rolesCache.length) {
      rolesListEl.innerHTML = '<div class="roles-empty">No roles defined yet.</div>';
      return;
    }
    rolesListEl.innerHTML = rolesCache.map(r => {
      const sel = (!rolesCreating && r.name === rolesSelected) ? ' selected' : '';
      return `<div class="role-row${sel}" data-role="${esc(r.name)}">
        <div class="role-row-name">${esc(r.name)}</div>
        <div class="role-row-desc">${esc(r.description)}</div>
      </div>`;
    }).join('');
    rolesListEl.querySelectorAll('.role-row').forEach(row => {
      row.addEventListener('click', () => selectRole(row.dataset.role));
    });
  }

  function enableEditor(on) {
    rolesSource.disabled = !on;
    rolesSave.disabled   = !on;
    rolesDelete.disabled = !on || rolesCreating;
  }

  async function selectRole(slug) {
    setRolesError('');
    rolesCreating = false;
    rolesSelected = slug;
    enableEditor(true);
    renderRolesList();
    rolesHeader.innerHTML = `Editing <span class="muted">${esc(slug)}</span>`;
    rolesSource.value = 'loading…';
    try {
      const res = await fetch(`/api/roles/${encodeURIComponent(slug)}`);
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      const data = await res.json();
      rolesSource.value = data.source ?? '';
    } catch (e) {
      rolesSource.value = '';
      setRolesError(String(e.message || e));
    }
  }

  function startCreate() {
    setRolesError('');
    rolesCreating = true;
    rolesSelected = null;
    enableEditor(true);
    renderRolesList();
    rolesHeader.innerHTML = 'New role <span class="muted">(unsaved)</span>';
    rolesSource.value = NEW_ROLE_TEMPLATE;
    rolesSource.focus();
  }

  function resetEditor() {
    rolesCreating = false;
    rolesSelected = null;
    rolesHeader.innerHTML = '<span class="muted">Select a role or create a new one.</span>';
    rolesSource.value = '';
    setRolesError('');
    enableEditor(false);
    rolesDelete.disabled = true;
  }

  async function loadRoles() {
    const res = await fetch('/api/roles');
    rolesCache = res.ok ? await res.json() : [];
    renderRolesList();
  }

  async function openRolesModal() {
    rolesBackdrop.classList.remove('hidden');
    resetEditor();
    await loadRoles();
  }

  function closeRolesModal() {
    rolesBackdrop.classList.add('hidden');
  }

  rolesBtn.addEventListener('click', openRolesModal);
  rolesCancel.addEventListener('click', closeRolesModal);
  rolesBackdrop.addEventListener('click', (e) => { if (e.target === rolesBackdrop) closeRolesModal(); });
  rolesNewBtn.addEventListener('click', startCreate);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !rolesBackdrop.classList.contains('hidden')) closeRolesModal();
  });

  rolesSave.addEventListener('click', async () => {
    setRolesError('');
    const source = rolesSource.value;
    rolesSave.disabled = true;
    rolesSave.textContent = '…';
    try {
      const url = rolesCreating ? '/api/roles' : `/api/roles/${encodeURIComponent(rolesSelected)}`;
      const method = rolesCreating ? 'POST' : 'PUT';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      // Auto-close on success and refresh the list.
      closeRolesModal();
      await loadRoles();
    } catch (e) {
      setRolesError(String(e.message || e));
    } finally {
      rolesSave.disabled = false;
      rolesSave.textContent = 'Save';
    }
  });

  rolesDelete.addEventListener('click', async () => {
    if (rolesCreating || !rolesSelected) return;
    if (!confirm(`Delete role "${rolesSelected}"? This removes the file on disk.`)) return;
    setRolesError('');
    try {
      const res = await fetch(`/api/roles/${encodeURIComponent(rolesSelected)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || res.statusText);
      resetEditor();
      await loadRoles();
    } catch (e) {
      setRolesError(String(e.message || e));
    }
  });
