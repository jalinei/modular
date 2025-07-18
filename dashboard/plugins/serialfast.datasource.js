(function () {
    const ipcRenderer = window.require?.("electron")?.ipcRenderer;
    class SerialFastDatasource {
        constructor(settings, updateCallback) {
            this.settings = settings;
            this.updateCallback = updateCallback;
            this.ipcHandler = (_e, msg) => {
                if (msg && msg.path === this.settings.portPath) {
                    this.updateCallback({ frame: msg.data });
                }
            };
            if (ipcRenderer) ipcRenderer.on('fast-frame', this.ipcHandler);
            this._openPort();
        }

        async updateNow() {
            if (!ipcRenderer) return;
            try {
                const data = await ipcRenderer.invoke('get-fast-data', { path: this.settings.portPath });
                if (data) {
                    this.updateCallback({ frame: data });
                }
            } catch (err) {
                console.error('Fast data update failed:', err);
            }
        }

        async _openPort() {
            if (!ipcRenderer) return;
            try {
                await ipcRenderer.invoke('open-serial-port', {
                    path: this.settings.portPath,
                    baudRate: this.settings.baudRate,
                    eol: this.settings.eol
                });
            } catch (e) {
                console.error('Open serial failed:', e.message);
            }
        }

        onDispose() {
            if (ipcRenderer) {
                ipcRenderer.removeListener('fast-frame', this.ipcHandler);
                if (this.settings.portPath) {
                    ipcRenderer.invoke('close-serial-port', { path: this.settings.portPath }).catch(() => {});
                }
            }
        }

        onSettingsChanged(newSettings) {
            if (ipcRenderer && this.settings.portPath && this.settings.portPath !== newSettings.portPath) {
                ipcRenderer.invoke('close-serial-port', { path: this.settings.portPath }).catch(() => {});
            }
            this.settings = newSettings;
            this._openPort();
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
                { name: 'eol', display_name: 'End of Line', type: 'text', default_value: '\\r\\n' }
            ],
            newInstance: function (settings, newInstanceCallback, updateCallback) {
                newInstanceCallback(new SerialFastDatasource(settings, updateCallback));
            }
        });
    }

    registerPlugin();
})();
