(function () {
  const ipc = window.require?.('electron')?.ipcRenderer;
  const fs = window.require?.('fs');
  const path = window.require?.('path');

  function thingsetDir() {
    try { return path.join(process.cwd(), 'thingset'); } catch { return null; }
  }

  function readJsonSafe(p) {
    try {
      const txt = fs.readFileSync(p, 'utf8');
      return JSON.parse(txt);
    } catch (e) {
      console.warn('readJsonSafe failed:', p, e?.message || e);
      return null;
    }
  }

  function lastSeg(p) { if (!p) return ''; return p.includes('/') ? p.split('/').pop() : p; }

  function valueToInline(v) {
    if (v == null) return '<span class="text-muted">null</span>';
    if (typeof v === 'object') return `<code>${escapeHtml(JSON.stringify(v))}</code>`;
    return `<code>${escapeHtml(String(v))}</code>`;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderNodeItem(key, node) {
    const item = $('<div class="mb-1"></div>');

    // Group children
    const hasChildren = node && node.children && typeof node.children === 'object' && Object.keys(node.children).length;
    const hasValues = node && node.values && typeof node.values === 'object' && Object.keys(node.values).length;
    const hasRecords = node && Array.isArray(node.records) && node.records.length;
    const hasValue = Object.prototype.hasOwnProperty.call(node || {}, 'value');

    const title = key || lastSeg(node?.path) || node?.id || 'Node';
    const summary = $(`<summary class="d-flex align-items-center gap-2">
        <strong>${escapeHtml(String(title))}</strong>
        ${node?.path ? `<span class="badge bg-light text-dark">${escapeHtml(node.path)}</span>` : ''}
        ${node?.id ? `<span class="badge bg-secondary">${escapeHtml(node.id)}</span>` : ''}
      </summary>`);

    if (hasChildren || hasValues || hasRecords) {
      const det = $('<details open class="border rounded px-2 py-1"></details>');
      det.append(summary);
      const body = $('<div class="ms-2 mt-1"></div>');

      if (hasValues) {
        const tbl = $('<div class="mb-1"></div>');
        for (const [vk, vv] of Object.entries(node.values)) {
          tbl.append(`<div class="d-flex justify-content-between"><span>${escapeHtml(vk)}</span><span>${valueToInline(vv)}</span></div>`);
        }
        body.append(tbl);
      }

      if (hasRecords) {
        const recWrap = $('<div class="mb-1"></div>');
        node.records.forEach((rec, i) => {
          const detRec = $(`<details class="border rounded px-2 py-1 mb-1"><summary>Record ${i}</summary></details>`);
          const inner = $('<div class="ms-2 mt-1"></div>');
          for (const [rk, rv] of Object.entries(rec || {})) {
            inner.append(`<div class="d-flex justify-content-between"><span>${escapeHtml(rk)}</span><span>${valueToInline(rv)}</span></div>`);
          }
          detRec.append(inner);
          recWrap.append(detRec);
        });
        body.append(recWrap);
      }

      if (hasChildren) {
        const kids = $('<div class="mt-1"></div>');
        for (const [ck, cn] of Object.entries(node.children)) kids.append(renderNodeItem(ck, cn));
        body.append(kids);
      }

      det.append(body);
      item.append(det);
    } else if (hasValue) {
      const row = $(`<div class="d-flex justify-content-between border rounded px-2 py-1">
          <span><strong>${escapeHtml(String(title))}</strong>${node?.path ? ` <span class=\"badge bg-light text-dark\">${escapeHtml(node.path)}</span>` : ''}</span>
          <span>${valueToInline(node.value)}</span>
        </div>`);
      item.append(row);
    }
    return item;
  }

  function renderTree(rootNode, filterText = '') {
    const wrap = $('<div class="d-flex flex-column"></div>');
    if (!rootNode) return wrap.append('<div class="text-muted">No data</div>'), wrap;

    const entries = rootNode.children && typeof rootNode.children === 'object'
      ? Object.entries(rootNode.children)
      : [];

    const filtered = (filterText || '').trim().toLowerCase();
    const match = (txt) => !filtered || (txt && String(txt).toLowerCase().includes(filtered));

    for (const [k, n] of entries) {
      if (!filtered) { wrap.append(renderNodeItem(k, n)); continue; }
      const flatText = JSON.stringify(n).toLowerCase();
      if (match(k) || match(n?.path) || flatText.includes(filtered)) wrap.append(renderNodeItem(k, n));
    }
    if (wrap.children().length === 0) wrap.append('<div class="text-muted">No matching nodes</div>');
    return wrap;
  }

  async function scanAndBuild(channel) {
    if (!ipc) return { ok: false, reason: 'no-ipc' };
    try {
      if (navigator.userAgent.toLowerCase().includes('linux')) {
        try { await ipc.invoke('can-setup-linux'); } catch (e) { /* user may cancel */ }
      }
      try { await ipc.invoke('can-open', { channel }); } catch {}
      await ipc.invoke('can-scan-nodes', { channel });
      await ipc.invoke('can-build-trees', { channel, maxDepth: 16 });
      return { ok: true };
    } catch (e) {
      console.error('scanAndBuild failed', e);
      return { ok: false, reason: e?.message || String(e) };
    }
  }

  function listDevices() {
    const dir = thingsetDir();
    if (!dir) return [];
    const np = path.join(dir, 'nodes.json');
    const mapping = readJsonSafe(np) || {};
    const out = [];
    for (const [addrStr, uid] of Object.entries(mapping)) {
      const addr = parseInt(addrStr, 10);
      if (!Number.isFinite(addr)) continue;
      const hex = `0x${addr.toString(16).toUpperCase().padStart(2, '0')}`;
      out.push({ value: addr, label: `${hex} — ${uid}`, hex, uid });
    }
    out.sort((a, b) => a.value - b.value);
    return out;
  }

  function readTreeForAddr(addr) {
    const dir = thingsetDir();
    if (!dir) return null;
    const hex = addr.toString(16).toUpperCase().padStart(2, '0');
    const fp = path.join(dir, `node_${hex}_tree.json`);
    return readJsonSafe(fp);
  }

  freeboard.loadWidgetPlugin({
    type_name: 'thingset_device_ui',
    display_name: 'ThingSet Device UI',
    description: 'Select a CAN device and render a UI from its datanodes (JSON tree).',
    settings: [
      { name: 'channel', display_name: 'Channel', type: 'text', default_value: 'can0' }
    ],
    newInstance: function (settings, newInstanceCallback) {
      newInstanceCallback(new DeviceUIWidget(settings));
    }
  });

  function DeviceUIWidget(settings) {
    let current = settings || {};
    const root = $('<div class="d-flex flex-column h-100 gap-2" style="overflow:auto;"></div>');

    const controls = $('<div class="d-flex flex-wrap gap-1 align-items-center"></div>');
    const devSelect = $('<select class="form-select form-select-sm" style="max-width: 360px;"></select>');
    const btnRefresh = $('<button class="btn btn-secondary btn-sm">Reload</button>');
    const btnScanBuild = $('<button class="btn btn-primary btn-sm">Scan + Build</button>');
    const filter = $('<input type="text" class="form-control form-control-sm" placeholder="Filter..." style="max-width: 240px;">');
    const status = $('<div class="small text-muted"></div>');
    const contentWrap = $('<div class="flex-fill overflow-auto" style="min-height: 160px;"></div>');
    const content = $('<div></div>');
    contentWrap.append(content);

    controls.append(
      $('<span class="input-group-text">Device</span>'),
      devSelect,
      btnRefresh,
      btnScanBuild,
      filter
    );
    root.append(controls, contentWrap, status);

    function populateDevices(selectFirst = false) {
      const devices = listDevices();
      devSelect.empty();
      devices.forEach(d => devSelect.append(`<option value="${d.value}">${d.label}</option>`));
      if (selectFirst && devices.length) devSelect.val(String(devices[0].value));
      status.text(devices.length ? `Found ${devices.length} device(s)` : 'No devices found. Use Scan + Build.');
      return devices;
    }

    function renderSelected() {
      const v = devSelect.val();
      if (!v) { content.empty(); status.text('Select a device.'); return; }
      const addr = parseInt(v, 10);
      const tree = readTreeForAddr(addr);
      if (!tree || !tree.root) { content.empty(); status.text('No tree JSON for this device. Use Scan + Build.'); return; }
      const ui = renderTree(tree.root, filter.val());
      content.empty().append(ui);
      const hex = `0x${addr.toString(16).toUpperCase().padStart(2, '0')}`;
      status.text(`Loaded ${hex} (${tree.node_uid || 'unknown uid'})`);
    }

    this.render = function (container) {
      $(container).css({ overflow: 'auto' });
      $(container).empty().append(root);
      populateDevices(true);
      renderSelected();

      btnRefresh.on('click', () => { populateDevices(); renderSelected(); });

      btnScanBuild.on('click', async () => {
        status.text('Scanning and building trees...');
        btnScanBuild.prop('disabled', true);
        const ch = current.channel || 'can0';
        const res = await scanAndBuild(ch);
        btnScanBuild.prop('disabled', false);
        if (!res.ok) status.text(`Scan failed: ${res.reason || 'unknown error'}`);
        populateDevices();
        renderSelected();
      });

      devSelect.on('change', renderSelected);
      filter.on('input', renderSelected);
    };

    this.onSettingsChanged = function (s) { current = s || {}; };
    this.onDispose = function () {};
    this.getHeight = function () { return 8; };
  }
}());
