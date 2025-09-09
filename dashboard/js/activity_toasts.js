(function () {
  // In-memory history of last N toasts
  const HISTORY_LIMIT = 10;
  const history = [];
  const tasks = new Map(); // key -> { title, label, variant, progress (0-100), startedAt }
  const progressToasts = new Map(); // key -> { el, toast }
  function ensureContainer() {
    let cont = document.querySelector('.toast-container');
    if (!cont) {
      cont = document.createElement('div');
      cont.className = 'toast-container activity-toasts position-fixed bottom-0 end-0 p-2';
      cont.style.zIndex = '1080';
      cont.style.display = 'flex';
      cont.style.flexDirection = 'column-reverse'; // first toast sits at bottom, newer toasts stack upwards
      cont.style.alignItems = 'flex-end';
      cont.style.gap = '0.375rem';
      // Ensure consistent spacing: override Bootstrap's child margins for this container
      if (!document.getElementById('activity-toasts-css')) {
        const st = document.createElement('style');
        st.id = 'activity-toasts-css';
        st.textContent = `.toast-container.activity-toasts .toast{margin:0 !important}`;
        document.head.appendChild(st);
      }
      document.body.appendChild(cont);
    }
    return cont;
  }

  function showToast({ variant = 'info', title = 'Activity', body = '', delay = 5000 }) {
    const cont = ensureContainer();
    const el = document.createElement('div');
    // Compact, neutral styling with colored accent bar
    el.className = `toast bg-dark text-light border-0 shadow-sm p-0 mb-0`;
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', 'assertive');
    el.setAttribute('aria-atomic', 'true');
    el.style.fontSize = '0.85rem';
    el.style.margin = '0';

    // Accent color per variant
    const accent = (() => {
      const root = document.documentElement;
      const css = (k, fb) => {
        try { const v = getComputedStyle(root).getPropertyValue(`--bs-${k}`).trim(); return v || fb; } catch { return fb; }
      };
      if (variant === 'success') return css('success', '#198754');
      if (variant === 'danger') return css('danger', '#dc3545');
      return css('secondary', '#6c757d');
    })();
    el.style.borderLeft = `4px solid ${accent}`;

    const icon = (function() {
      if (variant === 'success') {
        return '<svg class="me-1" width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: var(--bs-success)"><path d="M3 8 L6.5 11.5 L13 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      }
      if (variant === 'danger') {
        return '<svg class="me-1" width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: var(--bs-danger)"><path d="M4 4 L12 12 M12 4 L4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      }
      return '<span class="spinner-border spinner-border-sm text-secondary me-1" role="status" aria-hidden="true"></span>';
    })();
    el.innerHTML = `
      <div class="toast-header bg-transparent border-0 py-1 px-2">
        <strong class="me-auto">${icon}${escapeHtml(title)}</strong>
        <small class="text-light opacity-75">now</small>
        <button type="button" class="btn-close btn-close-white ms-2 mb-1" data-bs-dismiss="toast" aria-label="Close"></button>
      </div>
      <div class="toast-body py-2 px-2">${escapeHtml(body)}</div>
    `;
    cont.appendChild(el);

    // Record in history
    const item = { ts: Date.now(), variant, title: String(title || ''), body: String(body || '') };
    history.push(item);
    while (history.length > HISTORY_LIMIT) history.shift();
    updateActivityBadge();
    try {
      const opts = { autohide: true, delay: delay || 5000 };
      const Toast = window.bootstrap && window.bootstrap.Toast ? window.bootstrap.Toast : null;
      if (Toast) {
        const t = new Toast(el, opts);
        el.addEventListener('hidden.bs.toast', () => el.remove());
        t.show();
      } else {
        // Fallback: auto-remove after delay
        setTimeout(() => el.remove(), delay || 5000);
      }
    } catch { /* ignore */ }
  }

  function showProgressToast(key, { title = 'Task', label = '' } = {}) {
    const cont = ensureContainer();
    const el = document.createElement('div');
    el.className = `toast bg-dark text-light border-0 shadow-sm p-0 mb-0`;
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'true');
    el.style.fontSize = '0.85rem';
    el.style.margin = '0';

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--bs-primary').trim() || '#0d6efd';
    el.style.borderLeft = `4px solid ${accent}`;

    const header = `
      <div class="toast-header bg-transparent border-0 py-1 px-2">
        <span class="spinner-border spinner-border-sm text-secondary me-2 dfu-spin" role="status" aria-hidden="true"></span>
        <strong class="me-auto text-truncate" style="max-width:160px">${escapeHtml(title)}</strong>
        <small class="text-light opacity-75 dfu-status">flashing</small>
        <button type="button" class="btn-close btn-close-white ms-2 mb-1" data-bs-dismiss="toast" aria-label="Close"></button>
      </div>`;
    const body = `
      <div class="toast-body py-2 px-2">
        <div class="small text-muted mb-1 text-truncate" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
        <div class="progress" style="height:14px;">
          <div class="progress-bar" role="progressbar" style="width:0%" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">0%</div>
        </div>
      </div>`;
    el.innerHTML = header + body;
    cont.appendChild(el);

    const Toast = window.bootstrap && window.bootstrap.Toast;
    let toast = null;
    if (Toast) {
      toast = new Toast(el, { autohide: false });
      el.addEventListener('hidden.bs.toast', () => el.remove());
      toast.show();
    }
    progressToasts.set(key, { el, toast });
    return el;
  }

  function updateProgressToast(key, pct) {
    const ref = progressToasts.get(key);
    if (!ref) return;
    const bar = ref.el.querySelector('.progress-bar');
    if (!bar) return;
    const val = Math.round(Math.max(0, Math.min(100, pct)));
    bar.style.width = `${val}%`;
    bar.setAttribute('aria-valuenow', String(val));
    bar.textContent = `${val}%`;
  }

  function completeProgressToast(key, success = true, detail = '') {
    const ref = progressToasts.get(key);
    if (!ref) return;
    try {
      const badge = success ? 'success' : 'danger';
      const titleEl = ref.el.querySelector('.toast-header .me-auto');
      if (titleEl) titleEl.innerHTML = `${success ? '<svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\" style=\"color: var(--bs-success)\"><path d=\"M3 8 L6.5 11.5 L13 5\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>' : '<svg width=\"14\" height=\"14\" viewBox=\"0 0 16 16\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\" style=\"color: var(--bs-danger)\"><path d=\"M4 4 L12 12 M12 4 L4 12\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\"/></svg>'} ${titleEl.textContent}`;
      const spin = ref.el.querySelector('.dfu-spin');
      if (spin) spin.classList.add('d-none');
      const statusEl = ref.el.querySelector('.dfu-status');
      if (statusEl) statusEl.textContent = success ? 'done' : 'failed';
      const sub = ref.el.querySelector('.toast-body .small');
      if (sub && detail) sub.textContent = detail;
      setTimeout(() => {
        if (ref.toast) ref.toast.hide(); else ref.el.remove();
      }, 1200);
    } catch {}
    progressToasts.delete(key);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  const pending = new Map();
  function keyOf(evt) {
    return `${evt?.dsName || 'global'}|${evt?.id || 'activity'}`;
  }

  function handleActivity(evt) {
    if (!evt || !evt.state) return;
    const key = keyOf(evt);
    const label = evt.label || evt.id || 'Task';
    const title = evt.dsName || evt.title || 'Activity';
    const detail = evt.detail ? String(evt.detail) : '';
    const startDelay = 1200; // only show start toast if task runs longer than this

    if (evt.state === 'start') {
      // Defer the start toast to avoid flicker for very quick tasks
      const timer = setTimeout(() => {
        showToast({ variant: 'info', title, body: `${label} started` });
        pending.set(key, { shown: true });
      }, startDelay);
      pending.set(key, { timer, shown: false });

      // Track active DFU tasks with progress bars
      if (evt.id && (evt.id.startsWith('dfu:'))) {
        tasks.set(key, { id: evt.id, title, label, variant: 'info', progress: 0, startedAt: Date.now() });
        // Create a live progress toast for DFU tasks
        showProgressToast(key, { title, label });
        renderActiveTasks();
      }
    } else if (evt.state === 'done') {
      const rec = pending.get(key);
      if (rec && rec.timer) clearTimeout(rec.timer);
      pending.delete(key);
      const body = detail ? `${label} completed: ${detail}` : `${label} completed`;
      showToast({ variant: 'success', title, body, delay: 3500 });
      completeProgressToast(key, true, detail);

      if (tasks.has(key)) {
        tasks.delete(key);
        renderActiveTasks();
      }
    } else if (evt.state === 'error') {
      const rec = pending.get(key);
      if (rec && rec.timer) clearTimeout(rec.timer);
      pending.delete(key);
      const body = detail ? `${label} failed: ${detail}` : `${label} failed`;
      showToast({ variant: 'danger', title, body, delay: 6000 });
      completeProgressToast(key, false, detail);

      if (tasks.has(key)) {
        tasks.delete(key);
        renderActiveTasks();
      }
    }
  }

  // Listen to generic activity events emitted from either Freeboard or Electron IPC
  if (typeof freeboard !== 'undefined' && freeboard.on) {
    freeboard.on('activity', function (_e, evt) { handleActivity(evt); });
  }
  try {
    const ipc = window.require && window.require('electron') && window.require('electron').ipcRenderer;
    if (ipc && typeof ipc.on === 'function') {
      ipc.on('activity', (_e, evt) => handleActivity(evt));

      // Update DFU task progress from backend progress stream
      ipc.on('flash-progress', (_e, msg) => {
        try {
          const m = String(msg || '');
          const pm = m.match(/(\d{1,3}(?:\.\d+)?)%/);
          if (!pm) return;
          const p = Math.max(0, Math.min(100, parseFloat(pm[1])));
          // Pick the most recent active DFU task
          const keys = Array.from(tasks.keys()).filter(k => {
            const t = tasks.get(k); return t && t.id && t.id.startsWith('dfu:');
          });
          const lastKey = keys.length ? keys[keys.length - 1] : null;
          if (!lastKey) return;
          const t = tasks.get(lastKey);
          if (!t) return;
          t.progress = p;
          renderActiveTasks();
          updateProgressToast(lastKey, p);
        } catch {}
      });
    }
  } catch { /* ignore if not in Electron */ }

  // ---- Activity Center (history viewer) ----
  function ensureActivityCenter() {
    let btn = document.getElementById('activity-center-button');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'activity-center-button';
      btn.className = 'btn btn-secondary btn-sm position-fixed rounded-pill';
      btn.style.bottom = '0.75rem';
      btn.style.right = '0.75rem';
      btn.style.zIndex = '1091';
      btn.innerHTML = '<span class="me-1">Activity</span><span class="badge text-bg-dark" id="activity-center-badge">0</span>';
      btn.addEventListener('click', showActivityCenter);
      document.body.appendChild(btn);
    }

    let modal = document.getElementById('activityCenterModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'activityCenterModal';
      modal.className = 'modal fade';
      modal.tabIndex = -1;
      modal.innerHTML = `
        <div class="modal-dialog modal-sm modal-dialog-scrollable">
          <div class="modal-content bg-dark text-light">
            <div class="modal-header py-2">
              <h5 class="modal-title">Activity</h5>
              <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body p-0">
              <div class="p-2 border-bottom border-secondary-subtle" id="activityTasks"></div>
              <ul class="list-group list-group-flush" id="activityCenterList"></ul>
            </div>
            <div class="modal-footer py-2">
              <button type="button" class="btn btn-sm btn-outline-light" id="activityClearBtn">Clear</button>
              <button type="button" class="btn btn-sm btn-primary" data-bs-dismiss="modal">Close</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(modal);
      const clearBtn = modal.querySelector('#activityClearBtn');
      clearBtn.addEventListener('click', () => { history.length = 0; renderActivityList(); updateActivityBadge(); });
    }
  }

  function updateActivityBadge() {
    const badge = document.getElementById('activity-center-badge');
    if (badge) badge.textContent = String(history.length);
  }

  function renderActivityList() {
    const list = document.getElementById('activityCenterList');
    if (!list) return;
    list.innerHTML = '';
    const items = [...history].reverse();
    for (const it of items) {
      const li = document.createElement('li');
      li.className = 'list-group-item bg-dark text-light d-flex align-items-start';
      const time = new Date(it.ts).toLocaleTimeString();
      const icon = (function() {
        if (it.variant === 'success') return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: var(--bs-success)"><path d="M3 8 L6.5 11.5 L13 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        if (it.variant === 'danger') return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="color: var(--bs-danger)"><path d="M4 4 L12 12 M12 4 L4 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
        return '<span class="spinner-border spinner-border-sm text-secondary" role="status" aria-hidden="true"></span>';
      })();
      li.innerHTML = `
        <div class="me-2" style="width:16px;flex-shrink:0">${icon}</div>
        <div class="flex-grow-1">
          <div class="small text-muted">${time}</div>
          <div><strong>${escapeHtml(it.title)}</strong></div>
          <div class="small">${escapeHtml(it.body)}</div>
        </div>`;
      list.appendChild(li);
    }
  }

  function renderActiveTasks() {
    const box = document.getElementById('activityTasks');
    if (!box) return;
    const active = Array.from(tasks.entries());
    if (!active.length) {
      box.innerHTML = '<div class="text-muted small">No active tasks</div>';
      return;
    }
    const rows = active.map(([k, t]) => {
      const pct = Math.round(t.progress || 0);
      const bar = `
        <div class="progress" style="height:14px;">
          <div class="progress-bar" role="progressbar" style="width:${pct}%" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">${pct}%</div>
        </div>`;
      return `
        <div class="mb-2">
          <div class="d-flex align-items-center justify-content-between">
            <div class="small text-truncate d-flex align-items-center" title="${escapeHtml(t.title)}">
              <span class="spinner-border spinner-border-sm text-secondary me-2" role="status" aria-hidden="true"></span>
              <strong>${escapeHtml(t.title)}</strong>
            </div>
            <div class="small text-muted ms-2">${escapeHtml(t.label || '')}</div>
          </div>
          ${bar}
        </div>`;
    }).join('');
    box.innerHTML = rows;
  }

  function showActivityCenter() {
    ensureActivityCenter();
    renderActivityList();
    const modalEl = document.getElementById('activityCenterModal');
    const Modal = window.bootstrap && window.bootstrap.Modal;
    if (Modal && modalEl) {
      const mdl = Modal.getOrCreateInstance(modalEl, { backdrop: true });
      mdl.show();
    }
  }

  // Initialize controls once DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureActivityCenter);
  } else {
    ensureActivityCenter();
  }

  // Public API
  window.ActivityToasts = {
    show: showToast,
    history: () => [...history],
    showCenter: showActivityCenter,
    clear: () => { history.length = 0; updateActivityBadge(); }
  };
})();
