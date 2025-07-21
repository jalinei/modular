(function () {
    const ipcRenderer = window.require?.('electron')?.ipcRenderer;
    function FastFrameDatasource(settings, updateCallback) {
        let currentSettings = settings;
        let timer = null;

        async function openPort() {
            if (!ipcRenderer) return;
            try {
                await ipcRenderer.invoke('open-serial-port', {
                    path: currentSettings.portPath,
                    baudRate: currentSettings.baudRate,
                    separator: currentSettings.separator,
                    eol: currentSettings.eol
                });
            } catch (e) {
                console.error('Open serial failed:', e.message);
            }
        }

        async function pollFrame() {
            if (!ipcRenderer) return;
            try {
                const data = await ipcRenderer.invoke('get-fast-dataset', { path: currentSettings.portPath });
                if (data && Array.isArray(data.timestamps)) {
                    updateCallback(data);
                }
            } catch (e) {
                console.error('Failed to fetch fast frame:', e);
            }
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
            timer = setInterval(pollFrame, interval);
        }

        this.updateNow = pollFrame;

        this.onDispose = function () {
            stopTimer();
        };

        this.onSettingsChanged = function (newSettings) {
            currentSettings = newSettings;
            updateTimer();
            openPort();
        };

        updateTimer();
        openPort();
    }

    async function register() {
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
            type_name: 'fast_frame_datasource',
            display_name: 'Fast Serial Frame',
            description: 'Parse fast record frames from serial',
            settings: [
                {
                    name: 'portPath',
                    display_name: 'Port',
                    type: 'option',
                    options: portOptions,
                    default_value: portOptions.length ? portOptions[0].value : ''
                },
                { name: 'baudRate', display_name: 'Baud Rate', type: 'number', default_value: 115200 },
                { name: 'separator', display_name: 'Separator', type: 'text', default_value: ':' },
                { name: 'eol', display_name: 'End of Line', type: 'text', default_value: '\r\n' },
                { name: 'refresh', display_name: 'Refresh Every', type: 'number', suffix: 'ms', default_value: 1000 }
            ],
            newInstance: function (settings, newInstanceCallback, updateCallback) {
                newInstanceCallback(new FastFrameDatasource(settings, updateCallback));
            }
        });
    }

    register();
}());
