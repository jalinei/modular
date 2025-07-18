(function () {
    const ipcRenderer = window.require?.("electron")?.ipcRenderer;
    class SerialFastDatasource {
        constructor(settings, updateCallback) {
            this.settings = settings;
            this.updateCallback = updateCallback;
            this.timer = null;
            this.latest = null;
            this._start();
        }

        async _openPort() {
            if (!ipcRenderer) return;
            try {
                await ipcRenderer.invoke("open-serial-port", {
                    path: this.settings.portPath,
                    baudRate: this.settings.baudRate,
                    separator: this.settings.separator,
                    eol: this.settings.eol
                });
            } catch (e) {
                console.error("Open serial failed:", e.message);
            }
        }

        async _poll() {
            if (!ipcRenderer) return;
            try {
                const data = await ipcRenderer.invoke('get-fast-data', { path: this.settings.portPath });
                if (data && Array.isArray(data.data)) {
                    this.latest = data;
                }
            } catch (e) {
                console.error('Failed to get fast data:', e);
            }
        }

        updateNow = async () => {
            await this._poll();
            if (this.latest) {
                this.updateCallback(this.latest);
            }
        };

        onDispose() {
            if (this.timer) clearInterval(this.timer);
            if (ipcRenderer && this.settings.portPath) {
                ipcRenderer.invoke('close-serial-port', { path: this.settings.portPath }).catch(() => {});
            }
        }

        onSettingsChanged(newSettings) {
            this.settings = newSettings;
            this._openPort();
            this._startTimer();
        }

        _startTimer() {
            if (this.timer) clearInterval(this.timer);
            const interval = parseInt(this.settings.refresh) || 1000;
            this.timer = setInterval(() => this.updateNow(), interval);
        }

        _start() {
            this._openPort();
            this._startTimer();
        }
    }

    async function registerPlugin() {
        let portOptions = [];
        if (ipcRenderer) {
            try {
                const ports = await ipcRenderer.invoke('get-serial-ports');
                portOptions = ports.map(p => ({ name: p.name, value: p.value }));
            } catch (e) {
                console.error('Failed to list serial ports', e);
            }
        }

        freeboard.loadDatasourcePlugin({
            type_name: 'serialfast_datasource',
            display_name: 'Fast Serial Frame',
            description: 'Reads fast frame data from a serial port',
            settings: [
                { name: 'portPath', display_name: 'Port', type: 'option', options: portOptions, default_value: portOptions.length ? portOptions[0].value : '' },
                { name: 'baudRate', display_name: 'Baud Rate', type: 'number', default_value: 115200 },
                { name: 'separator', display_name: 'Separator', type: 'text', default_value: ':' },
                { name: 'eol', display_name: 'End of Line', type: 'text', default_value: '\\r\\n' },
                { name: 'refresh', display_name: 'Refresh Every', type: 'number', suffix: 'ms', default_value: 1000 }
            ],
            newInstance: function (settings, newInstanceCallback, updateCallback) {
                newInstanceCallback(new SerialFastDatasource(settings, updateCallback));
            }
        });
    }

    registerPlugin();
})();
