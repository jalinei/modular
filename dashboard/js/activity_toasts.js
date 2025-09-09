(function () {
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
    } else if (evt.state === 'done') {
      const rec = pending.get(key);
      if (rec && rec.timer) clearTimeout(rec.timer);
      pending.delete(key);
      const body = detail ? `${label} completed: ${detail}` : `${label} completed`;
      showToast({ variant: 'success', title, body, delay: 3500 });
    } else if (evt.state === 'error') {
      const rec = pending.get(key);
      if (rec && rec.timer) clearTimeout(rec.timer);
      pending.delete(key);
      const body = detail ? `${label} failed: ${detail}` : `${label} failed`;
      showToast({ variant: 'danger', title, body, delay: 6000 });
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
    }
  } catch { /* ignore if not in Electron */ }

  // Expose manual API if needed elsewhere
  window.ActivityToasts = { show: showToast };
})();
