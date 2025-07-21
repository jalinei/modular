(function () {
    const fs = window.require?.('fs');
    const path = window.require?.('path');

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
        let timer = null;

        function stopTimer() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        }

        function updateTimer() {
            stopTimer();
            const interval = parseInt(currentSettings.refresh, 10);
            if (!isNaN(interval) && interval > 0) {
                timer = setInterval(readFile, interval);
            }
        }

        function readFile() {
            if (!fs || !currentSettings.filePath) return;
            try {
                const data = fs.readFileSync(currentSettings.filePath, 'utf8');
                const ds = parseCsv(data, currentSettings.separator || ',', !!currentSettings.hasHeader);
                updateCallback(ds);
            } catch (e) {
                console.error('Failed to read CSV', e);
            }
        }

        this.updateNow = readFile;

        this.onDispose = function () {
            stopTimer();
        };

        this.onSettingsChanged = function (newSettings) {
            currentSettings = newSettings;
            updateTimer();
            readFile();
        };

        updateTimer();
        readFile();
    }

    freeboard.loadDatasourcePlugin({
        type_name: 'csv_file_datasource',
        display_name: 'CSV File',
        description: 'Load data from a CSV file and expose as dataset',
        settings: [
            { name: 'filePath', display_name: 'CSV File Path', type: 'text' },
            { name: 'separator', display_name: 'Separator', type: 'text', default_value: ',' },
            { name: 'hasHeader', display_name: 'First row is header', type: 'boolean', default_value: true },
            { name: 'refresh', display_name: 'Refresh Every', type: 'number', suffix: 'ms', default_value: 0 }
        ],
        newInstance: function (settings, newInstanceCallback, updateCallback) {
            newInstanceCallback(new CsvFileDatasource(settings, updateCallback));
        }
    });
})();
