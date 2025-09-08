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

  function renderNodeItem(key, node, ctx) {
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
          const row = $('<div class="d-flex align-items-center justify-content-between gap-2"></div>');
          const left = $(`<span>${escapeHtml(vk)}</span>`);
          const right = $('<span class="d-flex align-items-center gap-2"></span>');
          right.append($(valueToInline(vv)));

          const isReadable = typeof vk === 'string' && vk.startsWith('r');
          const isWritable = typeof vk === 'string' && vk.startsWith('w');

          if (isReadable && ctx?.ipc && ctx?.addr != null && ctx?.channel) {
            const btn = $('<button class="btn btn-outline-primary btn-sm">subscribe</button>');
            btn.on('click', async () => {
              try {
                btn.prop('disabled', true).text('working…');
                const fullPath = `${node.path}/${vk}`;
                // Resolve subset ID per device if not cached in context
                if (ctx.subsetId == null) {
                  try {
                    const subResp = await ctx.ipc.invoke('ts-ids-for-paths', {
                      channel: ctx.channel,
                      targetAddr: ctx.addr,
                      paths: ['mLive']
                    });
                    const sid = Array.isArray(subResp?.payload) ? subResp.payload[0] : null;
                    if (Number.isInteger(sid)) ctx.subsetId = sid;
                  } catch {}
                }
                const subscribed = btn.data('subscribed') === true;
                if (!subscribed) {
                  const cre = await ctx.ipc.invoke('ts-create', {
                    channel: ctx.channel,
                    targetAddr: ctx.addr,
                    endpoint: (ctx.subsetId != null ? ctx.subsetId : 'mLive'),
                    value: fullPath
                  });
                  if (cre && cre.status >= 0x80 && cre.status < 0xA0) {
                    btn.data('subscribed', true).text('unsubscribe').toggleClass('btn-outline-primary btn-outline-danger');
                    saveUiSubscription(ctx.addr, fullPath, true);
                  } else {
                    btn.text('subscribe');
                  }
                } else {
                  const del = await ctx.ipc.invoke('ts-delete', {
                    channel: ctx.channel,
                    targetAddr: ctx.addr,
                    endpoint: (ctx.subsetId != null ? ctx.subsetId : 'mLive'),
                    value: fullPath
                  });
                  if (del && del.status >= 0x80 && del.status < 0xA0) {
                    btn.data('subscribed', false).text('subscribe').toggleClass('btn-outline-danger btn-outline-primary');
                    saveUiSubscription(ctx.addr, fullPath, false);
                  } else {
                    btn.text('unsubscribe');
                  }
                }
              } catch {
                // ignore
              } finally {
                btn.prop('disabled', false);
              }
            });
            // Initialize from saved state
            try {
              const fullPathInit = `${node.path}/${vk}`;
              const savedSubbed = ctx?.uiState?.subscriptions && ctx.uiState.subscriptions[fullPathInit] === true;
              if (savedSubbed) btn.data('subscribed', true).text('unsubscribe').toggleClass('btn-outline-primary btn-outline-danger');
            } catch {}
            right.append(btn);
          }

          if (isWritable && ctx?.ipc && ctx?.addr != null && ctx?.channel) {
            const input = $('<input type="text" class="form-control form-control-sm" style="max-width: 140px;">');
            const send = $('<button class="btn btn-primary btn-sm">send</button>');
            send.on('click', async () => {
              const raw = String(input.val() ?? '').trim();
              let val;
              try {
                if (raw === '') return;
                if (/^(true|false|null)$/i.test(raw)) {
                  val = JSON.parse(raw.toLowerCase());
                } else if ((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('"') && raw.endsWith('"'))) {
                  val = JSON.parse(raw);
                } else {
                  const num = parseFloat(raw);
                  val = Number.isFinite(num) ? num : raw;
                }
              } catch { val = raw; }
              try {
                send.prop('disabled', true).text('sending…');
                const resp = await ctx.ipc.invoke('ts-update', {
                  channel: ctx.channel,
                  targetAddr: ctx.addr,
                  endpoint: node.path,
                  values: { [vk]: val }
                });
                if (resp && resp.status >= 0x80 && resp.status < 0xA0) {
                  right.children('code').remove();
                  right.prepend($(valueToInline(val)));
                }
              } catch {
                // ignore
              } finally {
                send.prop('disabled', false).text('send');
              }
            });
            right.append(input, send);
          }

          row.append(left, right);
          tbl.append(row);
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
        for (const [ck, cn] of Object.entries(node.children)) kids.append(renderNodeItem(ck, cn, ctx));
        body.append(kids);
      }

      det.append(body);
      item.append(det);
    } else if (hasValue) {
      const row = $(`<div class="d-flex align-items-center justify-content-between border rounded px-2 py-1 gap-2"></div>`);
      const left = $(`<span><strong>${escapeHtml(String(title))}</strong>${node?.path ? ` <span class=\"badge bg-light text-dark\">${escapeHtml(node.path)}</span>` : ''}</span>`);
      const right = $('<span class="d-flex align-items-center gap-2"></span>');
      right.append($(valueToInline(node.value)));

      const isReadable = typeof title === 'string' && title.startsWith('r');
      const isWritable = typeof title === 'string' && title.startsWith('w');
      if (isReadable && node?.path && ctx?.ipc && ctx?.addr != null && ctx?.channel) {
        const btn = $('<button class="btn btn-outline-primary btn-sm">subscribe</button>');
        btn.on('click', async () => {
          try {
            btn.prop('disabled', true).text('working…');
            const fullPath = node.path;
            // Resolve subset ID per device if not cached
            if (ctx.subsetId == null) {
              try {
                const subResp = await ctx.ipc.invoke('ts-ids-for-paths', {
                  channel: ctx.channel,
                  targetAddr: ctx.addr,
                  paths: ['mLive']
                });
                const sid = Array.isArray(subResp?.payload) ? subResp.payload[0] : null;
                if (Number.isInteger(sid)) ctx.subsetId = sid;
              } catch {}
            }
            const subscribed = btn.data('subscribed') === true;
            if (!subscribed) {
              const cre = await ctx.ipc.invoke('ts-create', {
                channel: ctx.channel,
                targetAddr: ctx.addr,
                endpoint: (ctx.subsetId != null ? ctx.subsetId : 'mLive'),
                value: fullPath
              });
              if (cre && cre.status >= 0x80 && cre.status < 0xA0) {
                btn.data('subscribed', true).text('unsubscribe').toggleClass('btn-outline-primary btn-outline-danger');
                saveUiSubscription(ctx.addr, fullPath, true);
              } else {
                btn.text('subscribe');
              }
            } else {
              const del = await ctx.ipc.invoke('ts-delete', {
                channel: ctx.channel,
                targetAddr: ctx.addr,
                endpoint: (ctx.subsetId != null ? ctx.subsetId : 'mLive'),
                value: fullPath
              });
              if (del && del.status >= 0x80 && del.status < 0xA0) {
                btn.data('subscribed', false).text('subscribe').toggleClass('btn-outline-danger btn-outline-primary');
                saveUiSubscription(ctx.addr, fullPath, false);
              } else {
                btn.text('unsubscribe');
              }
            }
          } catch {
            // ignore
          } finally { btn.prop('disabled', false); }
        });
        // Initialize from saved state
        try {
          const savedSubbed = ctx?.uiState?.subscriptions && ctx.uiState.subscriptions[node.path] === true;
          if (savedSubbed) btn.data('subscribed', true).text('unsubscribe').toggleClass('btn-outline-primary btn-outline-danger');
        } catch {}
        right.append(btn);
      }
      if (isWritable && node?.path && ctx?.ipc && ctx?.addr != null && ctx?.channel) {
        const input = $('<input type="text" class="form-control form-control-sm" style="max-width: 140px;">');
        const send = $('<button class="btn btn-primary btn-sm">send</button>');
        send.on('click', async () => {
          const key = title;
          const parentPath = (node.path.includes('/')) ? node.path.substring(0, node.path.lastIndexOf('/')) : '';
          const raw = String(input.val() ?? '').trim();
          let val;
          try {
            if (raw === '') return;
            if (/^(true|false|null)$/i.test(raw)) val = JSON.parse(raw.toLowerCase());
            else if ((raw.startsWith('[') && raw.endsWith(']')) || (raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('"') && raw.endsWith('"'))) val = JSON.parse(raw);
            else { const num = parseFloat(raw); val = Number.isFinite(num) ? num : raw; }
          } catch { val = raw; }
          try {
            send.prop('disabled', true).text('sending…');
            const resp = await ctx.ipc.invoke('ts-update', {
              channel: ctx.channel,
              targetAddr: ctx.addr,
              endpoint: parentPath,
              values: { [key]: val }
            });
            if (resp && resp.status >= 0x80 && resp.status < 0xA0) {
              right.children('code').remove();
              right.prepend($(valueToInline(val)));
            }
          } catch {}
          finally { send.prop('disabled', false).text('send'); }
        });
        right.append(input, send);
      }

      row.append(left, right);
      item.append(row);
    }
    return item;
  }

  function toBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
      if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === '') return false;
    }
    if (typeof v === 'number') return v !== 0;
    return !!v;
  }

  function renderTree(rootNode, filterText = '', ctx) {
    const wrap = $('<div class="d-flex flex-column"></div>');
    if (!rootNode) return wrap.append('<div class="text-muted">No data</div>'), wrap;

    const entries = rootNode.children && typeof rootNode.children === 'object'
      ? Object.entries(rootNode.children)
      : [];

    const filtered = (filterText || '').trim().toLowerCase();
    const match = (txt) => !filtered || (txt && String(txt).toLowerCase().includes(filtered));

    for (const [k, n] of entries) {
      if (!filtered) { wrap.append(renderNodeItem(k, n, ctx)); continue; }
      const flatText = JSON.stringify(n).toLowerCase();
      if (match(k) || match(n?.path) || flatText.includes(filtered)) wrap.append(renderNodeItem(k, n, ctx));
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

  function treeFilePathForAddr(addr) {
    const dir = thingsetDir();
    if (!dir) return null;
    const hex = addr.toString(16).toUpperCase().padStart(2, '0');
    return path.join(dir, `node_${hex}_tree.json`);
  }

  function writeTreeForAddr(addr, treeObj) {
    try {
      const fp = treeFilePathForAddr(addr);
      if (!fp) return false;
      fs.writeFileSync(fp, JSON.stringify(treeObj, null, 2), 'utf8');
      return true;
    } catch (e) {
      console.warn('writeTreeForAddr failed:', e?.message || e);
      return false;
    }
  }

  function saveUiSubscription(addr, fullPath, subscribed) {
    try {
      const tree = readTreeForAddr(addr);
      if (!tree || !tree.root) return false;
      tree.root._ui = tree.root._ui || {};
      tree.root._ui.subscriptions = tree.root._ui.subscriptions || {};
      if (subscribed) tree.root._ui.subscriptions[fullPath] = true;
      else delete tree.root._ui.subscriptions[fullPath];
      return writeTreeForAddr(addr, tree);
    } catch { return false; }
  }

  function findNodeByPathInTreeRoot(root, pathStr) {
    if (!root || !pathStr) return null;
    const segs = String(pathStr).split('/').filter(Boolean);
    let cur = root;
    for (const seg of segs) {
      if (!cur.children || typeof cur.children !== 'object') return null;
      cur = cur.children[seg];
      if (!cur) return null;
    }
    return cur;
  }

  function saveNodeValue(addr, pathStr, value) {
    try {
      const tree = readTreeForAddr(addr);
      if (!tree || !tree.root) return false;
      const node = findNodeByPathInTreeRoot(tree.root, pathStr);
      if (node) node.value = value;
      // Mirror under _ui for quick reads
      tree.root._ui = tree.root._ui || {};
      tree.root._ui.reporting = tree.root._ui.reporting || {};
      if (pathStr === '_Reporting/mLive/sEnable') tree.root._ui.reporting.sEnable = !!value;
      return writeTreeForAddr(addr, tree);
    } catch { return false; }
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
    const root = $('<div class="d-flex flex-column h-100 gap-2" style="min-height:0;"></div>');

    const controls = $('<div class="d-flex flex-wrap gap-1 align-items-center"></div>');
    const devSelect = $('<select class="form-select form-select-sm" style="max-width: 360px;"></select>');
    const btnRefresh = $('<button class="btn btn-secondary btn-sm">Reload</button>');
    const btnToggleReporting = $('<button class="btn btn-outline-success btn-sm">Enable reporting</button>');
    const btnScanBuild = $('<button class="btn btn-primary btn-sm">Scan + Build</button>');
    const filter = $('<input type="text" class="form-control form-control-sm" placeholder="Filter..." style="max-width: 240px;">');
    const status = $('<div class="small text-muted"></div>');
    const contentWrap = $('<div class="flex-fill" style="min-height:0; overflow:auto;"></div>');
    const content = $('<div></div>');
    contentWrap.append(content);

    controls.append(
      $('<span class="input-group-text">Device</span>'),
      devSelect,
      btnRefresh,
      btnScanBuild,
      btnToggleReporting,
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

    function findNodeByPath(root, pathStr) {
      if (!root || !pathStr) return null;
      const segs = String(pathStr).split('/').filter(Boolean);
      let cur = root;
      for (const seg of segs) {
        if (!cur.children || typeof cur.children !== 'object') return null;
        cur = cur.children[seg];
        if (!cur) return null;
      }
      return cur;
    }

    function updateReportingButton(addr, tree) {
      // Default disabled state when not available
      btnToggleReporting.prop('disabled', true)
        .removeClass('btn-success btn-outline-danger btn-outline-success')
        .addClass('btn-outline-success')
        .text('Enable reporting');

      if (!addr || !tree || !tree.root) return;
      const sEnableNode = findNodeByPath(tree.root, '_Reporting/mLive/sEnable');
      if (!sEnableNode) return; // keep disabled if feature not present
      const enabled = toBool(sEnableNode.value);
      setReportingButtonState(enabled);
    }

    function setReportingButtonState(enabled) {
      btnToggleReporting.prop('disabled', false)
        .toggleClass('btn-outline-success', !enabled)
        .toggleClass('btn-outline-danger', enabled)
        .text(enabled ? 'Disable reporting' : 'Enable reporting')
        .data('enabled', !!enabled);
    }

    function updateSenableValueInUI(enabled) {
      try {
        const pathBadge = content.find('span.badge.bg-light.text-dark').filter((i, el) => $(el).text() === '_Reporting/mLive/sEnable');
        if (!pathBadge.length) return;
        const row = pathBadge.closest('.d-flex.align-items-center.justify-content-between');
        const codeEl = row.find('code').first();
        if (codeEl && codeEl.length) codeEl.text(String(!!enabled));
      } catch {}
    }

    async function toggleReporting(addr, channel, enable) {
      if (!ipc || addr == null || !channel) return { ok: false };
      try {
        const resp = await ipc.invoke('ts-update', {
          channel,
          targetAddr: addr,
          endpoint: '_Reporting/mLive',
          values: { sEnable: !!enable }
        });
        const ok = resp && resp.status >= 0x80 && resp.status < 0xA0;
        return { ok };
      } catch (e) {
        return { ok: false, error: e?.message || String(e) };
      }
    }

    function renderSelected() {
      const v = devSelect.val();
      if (!v) { content.empty(); status.text('Select a device.'); return; }
      const addr = parseInt(v, 10);
      const tree = readTreeForAddr(addr);
      if (!tree || !tree.root) { content.empty(); status.text('No tree JSON for this device. Use Scan + Build.'); return; }
      let subsetId = null;
      try {
        const idStr = tree?.root?.children?.mLive?.id;
        if (typeof idStr === 'string' && idStr.startsWith('0x')) subsetId = parseInt(idStr, 16);
      } catch {}
      const ctx = { ipc, channel: current.channel || 'can0', addr, subsetId, uiState: (tree?.root?._ui || {}) };
      const ui = renderTree(tree.root, filter.val(), ctx);
      content.empty().append(ui);
      const hex = `0x${addr.toString(16).toUpperCase().padStart(2, '0')}`;
      status.text(`Loaded ${hex} (${tree.node_uid || 'unknown uid'})`);

      // Update reporting toggle button based on current tree
      updateReportingButton(addr, tree);
    }

    this.render = function (container) {
      const $container = $(container);
      // Ensure the widget itself fills its parent; scrolling happens in contentWrap
      $container.css({ overflow: 'hidden' });
      $container.empty().append(root);
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

      btnToggleReporting.on('click', async () => {
        const v = devSelect.val();
        if (!v) return;
        const addr = parseInt(v, 10);
        const channel = current.channel || 'can0';
        const willEnable = !(btnToggleReporting.data('enabled') === true);
        btnToggleReporting.prop('disabled', true).text('Working…');
      const res = await toggleReporting(addr, channel, willEnable);
      if (res.ok) {
        // Trust the requested state immediately and update button + inline value
        const enabledNow = !!willEnable;
        setReportingButtonState(enabledNow);
        updateSenableValueInUI(enabledNow);
        saveNodeValue(addr, '_Reporting/mLive/sEnable', enabledNow);
      } else {
          // On failure, restore previous label from data
          const prevEnabled = btnToggleReporting.data('enabled') === true;
          setReportingButtonState(prevEnabled);
        }
      });

      devSelect.on('change', renderSelected);
      filter.on('input', renderSelected);
    };

    this.onSettingsChanged = function (s) { current = s || {}; };
    this.onDispose = function () {};
    this.getHeight = function () { return 8; };
  }
}());
