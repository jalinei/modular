(function () {
  const ipcRenderer = window.require?.('electron')?.ipcRenderer;
  const isLinux = navigator.userAgent.toLowerCase().includes('linux');
  // Shared options array reference for the settings UI; mutated after setup+scan.
  const deviceOptionsRef = [];

  async function setupCanIfLinux(channel) {
    if (!ipcRenderer) return;
    if (!isLinux) return;
    try {
      await ipcRenderer.invoke('can-setup-linux');
    } catch (e) {
      console.warn('can-setup-linux failed or was cancelled:', e?.message || e);
    }
  }

  async function scanDevices(channel) {
    if (!ipcRenderer) return [];
    try {
      const res = await ipcRenderer.invoke('can-scan-nodes', { channel });
      const nodes = res?.nodes || {};
      const options = Object.keys(nodes).map((addrStr) => {
        const addr = parseInt(addrStr, 10);
        const label = `0x${addr.toString(16).toUpperCase().padStart(2, '0')} — ${nodes[addrStr]}`;
        return { name: label, value: addr };
      });
      options.sort((a, b) => a.value - b.value);
      return options;
    } catch (e) {
      console.error('CAN scan failed:', e);
      return [];
    }
  }

  function CanDatasource(settings, updateCallback) {
    let currentSettings = settings;
    let timer = null;
    let deviceMeta = null;

    async function ensureOpen() {
      if (!ipcRenderer) return;
      try {
        await ipcRenderer.invoke('can-open', { channel: currentSettings.channel || 'can0' });
      } catch (e) {
        console.warn('can-open failed:', e?.message || e);
      }
    }

    async function poll() {
      // For now, output selected device info and a timestamp heartbeat
      const out = {
        channel: currentSettings.channel || 'can0',
        targetAddr: currentSettings.targetAddr || null,
        device_uid: deviceMeta?.uid || null,
        numeric_value: Date.now(),
      };
      updateCallback(out);
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
    };

    (async () => {
      const ch = currentSettings.channel || 'can0';
      await setupCanIfLinux(ch);
      await ensureOpen();
      // After interface is up, scan and mutate the shared options so the editor sees devices next time it's opened.
      try {
        const opts = await scanDevices(ch);
        deviceOptionsRef.splice(0, deviceOptionsRef.length, ...opts);
        // Extra step: build ThingSet trees for found devices, same as `npm run ts:query`.
        try {
          await ipcRenderer.invoke('can-build-trees', { channel: ch, maxDepth: 16 });
        } catch (e) {
          console.warn('ThingSet query/build failed:', e?.message || e);
        }
      } catch {}
      updateTimer();
    })();
  }

  async function registerPlugin() {
    const channelDefault = 'can0';
    // Do not scan at startup. Options start empty and will be filled after the datasource sets up CAN.

    freeboard.loadDatasourcePlugin({
      type_name: 'can_datasource',
      display_name: 'ThingSet CAN',
      description: 'Sets up SocketCAN, scans the bus, and lets you pick a device',
      settings: [
        { name: 'channel', display_name: 'Channel', type: 'text', default_value: channelDefault },
        {
          name: 'targetAddr',
          display_name: 'Device',
          type: 'option',
          options: deviceOptionsRef,
          description: 'Click Create to setup CAN, then reopen to pick a device.',
        },
        { name: 'refresh', display_name: 'Refresh Every', type: 'number', suffix: 'ms', default_value: 1000 },
      ],
      newInstance: function (settings, newInstanceCallback, updateCallback) {
        newInstanceCallback(new CanDatasource(settings, updateCallback));
      }
    });
  }

  registerPlugin();
}());
