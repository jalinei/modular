(function () {
    const fs = window.require?.('fs');
    const ipc = window.require?.('electron')?.ipcRenderer;

    function parseCsv(text, sep, hasHeader) {
        const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
        if (!lines.length) return { timestamps: [], series: [] };

        let start = 0;
        if (hasHeader) {
            start = 1;
        }
        const first = lines[start] || '';
        const count = first.split(sep).length;
        const cols = Array.from({ length: count }, () => []);
        for (let i = start; i < lines.length; i++) {
            const parts = lines[i].split(sep);
            for (let j = 0; j < count; j++) {
                const val = parts[j] || '';
                if (j === 0) {
                    const num = parseFloat(val);
                    cols[j].push(isNaN(num) ? Date.parse(val) || 0 : num);
                } else {
                    const f = parseFloat(val);
                    cols[j].push(isNaN(f) ? null : f);
                }
            }
        }
        const timestamps = cols.shift();
        return { timestamps, series: cols };
    }

    function CsvFileDatasource(settings, updateCallback) {
        let currentSettings = settings;
        let filePath = currentSettings.filePath || null;

        async function chooseFile() {
            if (ipc) {
                const chosen = await ipc.invoke('choose-csv-file');
                if (chosen) {
                    filePath = chosen;
                    loadFile();
                }
            } else if (window.File && window.FileReader) {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.csv';
                await new Promise(resolve => {
                    input.addEventListener('change', () => {
                        const file = input.files[0];
                        if (!file) { resolve(); return; }
                        const reader = new FileReader();
                        reader.onload = () => {
                            const ds = parseCsv(reader.result, currentSettings.separator || ',', !!currentSettings.hasHeader);
                            updateCallback(ds);
                            resolve();
                        };
                        reader.readAsText(file);
                    });
                    input.click();
                });
                return;
            }
        }

        function loadFile() {
            if (!fs || !filePath) return;
            try {
                const data = fs.readFileSync(filePath, 'utf8');
                const ds = parseCsv(data, currentSettings.separator || ',', !!currentSettings.hasHeader);
                updateCallback(ds);
            } catch (e) {
                console.error('Failed to read CSV', e);
            }
        }

        this.updateNow = async () => {
            if (!filePath) await chooseFile();
            loadFile();
        };

        this.onDispose = function () {};

        this.onSettingsChanged = function (newSettings) {
            currentSettings = newSettings;
            filePath = currentSettings.filePath || filePath;
            this.updateNow();
        };

        this.updateNow();
    }

    freeboard.loadDatasourcePlugin({
        type_name: 'csv_file_datasource',
        display_name: 'CSV File',
        description: 'Load data from a CSV file and expose as dataset',
        settings: [
            { name: 'filePath', display_name: 'CSV File Path', type: 'text' },
            { name: 'separator', display_name: 'Separator', type: 'text', default_value: ',' },
            { name: 'hasHeader', display_name: 'First row is header', type: 'boolean', default_value: true }
        ],
        newInstance: function (settings, newInstanceCallback, updateCallback) {
            newInstanceCallback(new CsvFileDatasource(settings, updateCallback));
        }
    });
})();
