(function () {
    freeboard.loadWidgetPlugin({
        type_name: "serial_csv_recorder",
        display_name: "Serial CSV Recorder",
        description: "Start/stop CSV recording on a serial datasource",
        settings: [
            {
                name: "datasource",
                display_name: "Datasource Name",
                type: "text"
            },
            {
                name: "filePath",
                display_name: "CSV File Path",
                type: "text",
                default_value: "record.csv"
            },
            {
                name: "separator",
                display_name: "Separator",
                type: "text",
                default_value: ":"
            },
            {
                name: "eol",
                display_name: "End Of Line",
                type: "text",
                default_value: "\\n"
            }
        ],
        newInstance: function (settings, newInstanceCallback) {
            newInstanceCallback(new SerialCsvRecorder(settings));
        }
    });

    class SerialCsvRecorder {
        constructor(settings) {
            this.settings = settings;
            this.ipc = window.require?.("electron")?.ipcRenderer;
            this.isRecording = false;
            this.button = $('<button class="serial-rec-btn"></button>').text('Start Record');
            this.portPath = null;
        }

        render(containerElement) {
            $(containerElement).append(this.button);
            this.button.on('click', () => this._toggleRecord());
        }

        async _toggleRecord() {
            if (!this.ipc) return;
            if (this.isRecording) {
                await this.ipc.invoke('stop-csv-record', { path: this.portPath });
                this.isRecording = false;
                this.button.text('Start Record');
            } else {
                const dsSettings = freeboard.getDatasourceSettings(this.settings.datasource) || {};
                this.portPath = dsSettings.portPath || this.settings.datasource;
                await this.ipc.invoke('start-csv-record', {
                    path: this.portPath,
                    filePath: this.settings.filePath,
                    separator: dsSettings.separator || this.settings.separator,
                    eol: dsSettings.eol || this.settings.eol
                });
                this.isRecording = true;
                this.button.text('Stop Record');
            }
        }

        onSettingsChanged(newSettings) {
            this.settings = newSettings;
        }

        onDispose() {
            if (this.isRecording && this.ipc) {
                this.ipc.invoke('stop-csv-record', { path: this.portPath });
            }
        }

        getHeight() {
            return 1;
        }
    }
})();