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
            },
            {
                name: "order",
                display_name: "Data Order",
                type: "option",
                options: [
                    { name: "Old data on top", value: "old" },
                    { name: "New data on top", value: "new" }
                ],
                default_value: "old"
            },
            {
                name: "addHeader",
                display_name: "Add label on the first line",
                type: "boolean",
                default_value: true
            },
            {
                name: "timestampMode",
                display_name: "Timestamp",
                type: "option",
                options: [
                    { name: "None", value: "none" },
                    { name: "Relative", value: "relative" },
                    { name: "Absolute", value: "absolute" }
                ],
                default_value: "none"
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
            this.container = $('<div style="height:100%; display:flex; flex-direction:column; gap:4px;"></div>');

            // Dropdown of available serial datasources
            this.dsSelect = $('<select style="flex:1; box-sizing:border-box;"></select>');
            this._refreshDatasourceOptions();
            this.dsSelect.on('change', () => {
                this.settings.datasource = this.dsSelect.val();
            });

            this._configHandler = () => this._refreshDatasourceOptions();
            freeboard.on && freeboard.on('config_updated', this._configHandler);

            const makeRow = (labelText, inputEl) => {
                const row = $('<div style="display:flex; align-items:center; gap:4px;"></div>');
                const label = $(`<label style="flex:1;">${labelText}</label>`);
                row.append(label).append(inputEl);
                return row;
            };

            this.orderSelect = $('<select style="flex:1; box-sizing:border-box;"></select>');
            this.orderSelect.append('<option value="old">Old data on top</option>');
            this.orderSelect.append('<option value="new">Early data on top</option>');

            this.headerCheck = $('<input type="checkbox">');
            this.timeSelect = $('<select style="flex:1; box-sizing:border-box;"></select>');
            this.timeSelect.append('<option value="none">None</option>');
            this.timeSelect.append('<option value="relative">Relative</option>');
            this.timeSelect.append('<option value="absolute">Absolute</option>');

            this.button = $('<button class="serial-rec-btn" style="width:100%; box-sizing:border-box; height:32px;"></button>').text('Start Record');
            this.portPath = null;

            this.container.append(
                makeRow('Datasource', this.dsSelect),
                makeRow('Data Order', this.orderSelect),
                makeRow('Add label on the first line', this.headerCheck),
                makeRow('Timestamp', this.timeSelect),
                this.button
            );
        }

        render(containerElement) {
            this._syncControls();
            $(containerElement).append(this.container);
            this.button.on('click', () => this._toggleRecord());

            this.orderSelect.on('change', () => {
                this.settings.order = this.orderSelect.val();
            });
            this.headerCheck.on('change', () => {
                this.settings.addHeader = this.headerCheck.prop('checked');
            });
            this.timeSelect.on('change', () => {
                this.settings.timestampMode = this.timeSelect.val();
            });
        }

        _syncControls() {
            this.orderSelect.val(this.settings.order || 'old');
            this.headerCheck.prop('checked', !!this.settings.addHeader);
            this.timeSelect.val(this.settings.timestampMode || 'none');
            this._refreshDatasourceOptions();
            if (this.settings.datasource) {
                this.dsSelect.val(this.settings.datasource);
            }
        }

        _refreshDatasourceOptions() {
            const live = freeboard.getLiveModel?.();
            if (!live || typeof live.datasources !== 'function') return;
            const list = live.datasources();
            const current = this.settings.datasource;
            this.dsSelect.empty();
            list.forEach(ds => {
                try {
                    if (ds.type && ds.type() === 'serialport_datasource') {
                        const name = ds.name();
                        this.dsSelect.append(`<option value="${name}">${name}</option>`);
                    }
                } catch (e) { /* ignore */ }
            });
            if (current && this.dsSelect.find(`option[value='${current}']`).length === 0) {
                this.dsSelect.append(`<option value="${current}">${current}</option>`);
            }
            this.dsSelect.val(current);
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
                const headers = (dsSettings.headers || '').split(/[,;]+/).map(h => h.trim()).filter(h => h);
                await this.ipc.invoke('start-csv-record', {
                    path: this.portPath,
                    filePath: this.settings.filePath,
                    separator: dsSettings.separator || this.settings.separator,
                    eol: dsSettings.eol || this.settings.eol,
                    order: this.settings.order,
                    addHeader: this.settings.addHeader,
                    timestampMode: this.settings.timestampMode,
                    headers
                });
                this.isRecording = true;
                this.button.text('Stop Record');
            }
        }

        onSettingsChanged(newSettings) {
            this.settings = newSettings;
            this._syncControls();
        }

        onDispose() {
            if (this.isRecording && this.ipc) {
                this.ipc.invoke('stop-csv-record', { path: this.portPath });
            }
            if (this._configHandler && freeboard.off) {
                freeboard.off('config_updated', this._configHandler);
            }
        }

        getHeight() {
            return 3;
        }
    }
})();