(function () {
  const ipcRenderer = window.require?.('electron')?.ipcRenderer;
  const isLinux = navigator.userAgent.toLowerCase().includes('linux');

  // Activity toasts are generated in the backend (main.js) via IPC.

  async function setupCanIfLinux(channel) {
    if (!ipcRenderer) return true;
    if (!isLinux) return true;
    try {
      await ipcRenderer.invoke('can-setup-linux');
      return true;
    } catch (e) {
      console.warn('can-setup-linux failed or was cancelled:', e?.message || e);
      return false;
    }
  }

  async function scanAndBuildTrees(channel) {
    if (!ipcRenderer) return { scanned: 0, built: 0 };
    let scanned = 0;
    let built = 0;
    // Scan writes thingset/nodes.json
    const scanRes = await ipcRenderer.invoke('can-scan-nodes', { channel });
    try {
      const nodes = scanRes?.nodes || {};
      scanned = Object.keys(nodes).length;
    } catch {}
    // Build ThingSet trees per node so aggregator can map IDs to paths
    const buildRes = await ipcRenderer.invoke('can-build-trees', { channel, maxDepth: 16 });
    try {
      built = Array.isArray(buildRes?.written) ? buildRes.written.length : 0;
    } catch {}
    return { scanned, built };
  }

  function CanDatasource(settings, updateCallback) {
    let currentSettings = settings;
    let timer = null;
    let deviceMeta = null;
    let lastSelectedAddr = null;

    async function ensureOpen() {
      if (!ipcRenderer) return;
      try {
        await ipcRenderer.invoke('can-open', { channel: currentSettings.channel || 'can0' });
      } catch (e) {
        console.warn('can-open failed:', e?.message || e);
      }
    }

    async function poll() {
      const ch = currentSettings.channel || 'can0';
      const now = new Date();
      let data = {
        numeric_value: now.getTime(),
        full_string_value: now.toLocaleString()
      };
      try {
        if (ipcRenderer) {
          const snap = await ipcRenderer.invoke('can-aggregate-snapshot', { channel: ch });
          const nodes = snap?.nodes || {};
          const nodeKeys = Object.keys(nodes);

          // Always expose per-device objects: data['0xNN'] = { rV1Low_V: val, ... }
          for (const [addrHex, node] of Object.entries(nodes)) {
            if (!node || !node.flat) continue;
            const map = {};
            for (const [path, val] of Object.entries(node.flat)) {
              if (typeof val !== 'number' || !isFinite(val)) continue;
              const leaf = typeof path === 'string' && path.includes('/') ? path.split('/').pop() : String(path);
              map[leaf] = val;
            }
            data[addrHex] = map;
          }

          if (nodeKeys.length) {
            // Resolve target device for serial-like y1..yN view
            let sel = (currentSettings.device || currentSettings.deviceAddr || 'auto');
            sel = typeof sel === 'string' ? sel.trim() : sel;
            let targetKey = null;
            if (typeof sel === 'string' && sel.toLowerCase() !== 'auto') {
              // Accept '0xNN' hex or decimal address
              let addrNum = null;
              if (/^0x[0-9a-f]+$/i.test(sel)) addrNum = parseInt(sel, 16);
              else if (/^\d+$/.test(sel)) addrNum = parseInt(sel, 10);
              if (Number.isFinite(addrNum)) {
                const hex = `0x${addrNum.toString(16).toUpperCase().padStart(2, '0')}`;
                if (nodes[hex]) targetKey = hex;
              }
            }
            if (!targetKey) targetKey = nodeKeys[0];
            lastSelectedAddr = targetKey;

            const node = nodes[targetKey] || {};
            const entries = Object.entries(node.flat || {});
            // Stable order by key to keep channel indices consistent across polls
            entries.sort((a, b) => a[0].localeCompare(b[0]));
            const y = [];
            const labels = [];
            for (const [path, val] of entries) {
              if (typeof val !== 'number' || !isFinite(val)) continue;
              y.push(val);
              const leaf = typeof path === 'string' && path.includes('/') ? path.split('/').pop() : String(path);
              labels.push(leaf);
            }
            // Serial-like fields y1..yN + keep { y, labels } for widgets that use them
            for (let i = 0; i < y.length; i++) data[`y${i + 1}`] = y[i];
            data.y = y;
            data.labels = labels;
            data.device = targetKey;
          }
        }
      } catch (e) {
        console.warn('poll aggregate failed:', e?.message || e);
      }

      try {
        if (currentSettings && currentSettings.debug) {
          // Expose last payload for quick inspection from DevTools
          window.__CAN_DS_LAST__ = data;
          // Log concise summary
          const keys = Object.keys(data).filter(k => /^y\d+$/.test(k));
          console.log('[CAN DS]', 'device=', data.device || 'n/a', 'channels=', keys.length, data);
        }
      } catch {}

      updateCallback(data);
    }

    function stopTimer() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }

    function updateTimer() {
      stopTimer();
      let interval = parseFloat(currentSettings.refresh);
      if (isNaN(interval) || interval < 50) interval = 1000;
      timer = setInterval(poll, interval);
    }

    this.updateNow = poll;

    this.onDispose = function () {
      stopTimer();
      // Intentionally not closing the CAN channel here to avoid disrupting other datasources/widgets.
    };

    this.onSettingsChanged = async function (newSettings) {
      currentSettings = newSettings;
      await ensureOpen();
      updateTimer();
      try {
        if (ipcRenderer) {
          const ch = currentSettings.channel || 'can0';
          await ipcRenderer.invoke('can-aggregate-set-debug', { channel: ch, enable: !!currentSettings.debug });
        }
      } catch (e) {
        console.warn('set debug failed:', e?.message || e);
      }
    };

    (async () => {
      const ch = currentSettings.channel || 'can0';
      await setupCanIfLinux(ch);
      await ensureOpen();
      // Scan nodes and build trees to enable id->path mapping, then start aggregator
      try { await scanAndBuildTrees(ch); } catch (e) { /* backend toasts handle errors */ }
      try { await ipcRenderer.invoke('can-aggregate-start', { channel: ch }); } catch (e) { /* backend handles */ }
      try { await ipcRenderer.invoke('can-aggregate-set-debug', { channel: ch, enable: !!currentSettings.debug }); } catch (e) { /* ignore */ }
      updateTimer();
    })();
  }

  async function registerPlugin() {
    const channelDefault = 'can0';

    freeboard.loadDatasourcePlugin({
      type_name: 'can_datasource',
      display_name: 'ThingSet CAN',
      description: 'Reads ThingSet CAN broadcasts and exposes serial-like y1..yN for a selected device',
      settings: [
        { name: 'channel', display_name: 'Channel', type: 'text', default_value: channelDefault },
        { name: 'device', display_name: 'Device (hex addr or "auto")', type: 'text', default_value: 'auto' },
        { name: 'refresh', display_name: 'Refresh Every', type: 'number', suffix: 'ms', default_value: 1000 },
        { name: 'debug', display_name: 'Debug logs', type: 'boolean', default_value: false },
      ],
      newInstance: function (settings, newInstanceCallback, updateCallback) {
        newInstanceCallback(new CanDatasource(settings, updateCallback));
      }
    });
  }

  registerPlugin();
}());
