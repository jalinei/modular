(function () {
    freeboard.loadWidgetPlugin({
        type_name: "serial_header_editor",
        display_name: "Serial Header Editor",
        description: "Edit header labels for a serial datasource",
        settings: [],
        newInstance: function (settings, newInstanceCallback) {
            newInstanceCallback(new SerialHeaderEditor(settings));
        }
    });

    class SerialHeaderEditor {
        constructor(settings) {
            this.settings = settings;
            this.ipc = window.require?.("electron")?.ipcRenderer;
            this.container = $('<div class="d-flex flex-column h-100 gap-2 overflow-auto"></div>');
            this.dsSelect = $('<select class="form-select form-select-sm flex-fill"></select>');
            this.tableWrap = $('<div class="flex-fill overflow-auto"></div>');
            this.table = $(
                '<table class="table table-bordered table-sm mb-0" style="table-layout:fixed;">' +
                '<thead><tr><th style="width:30px">#</th><th>Label</th><th style="width:30px"></th></tr></thead>' +
                '<tbody></tbody></table>'
            );
            this.addBtn = $('<button class="btn btn-secondary btn-sm">Add Field</button>');
            this.saveBtn = $('<button class="btn btn-primary btn-sm">Save</button>');
            this._configHandler = () => this._refreshDatasourceOptions();
            freeboard.on && freeboard.on('config_updated', this._configHandler);
        }

        render(el) {
            $(el).append(this.container);
            const dsRow = $('<div class="input-group input-group-sm mb-1"></div>');
            dsRow.append('<span class="input-group-text">Datasource</span>', this.dsSelect);
            const btnRow = $('<div class="d-flex gap-1"></div>').append(this.addBtn, this.saveBtn);
            this.container.append(dsRow, this.tableWrap, btnRow);
            this.tableWrap.append(this.table);
            this.addBtn.on('click', () => this._addRow());
            this.saveBtn.on('click', () => this._save());
            this.dsSelect.on('change', () => {
                this.settings.datasource = this.dsSelect.val();
                this._loadHeaders();
            });
            this._refreshDatasourceOptions();
            if (this.settings.datasource) {
                this.dsSelect.val(this.settings.datasource);
            }
            this._loadHeaders();
        }

        async _getPortPath() {
            const dsSettings = freeboard.getDatasourceSettings(this.settings.datasource) || {};
            return dsSettings.portPath || this.settings.datasource;
        }

        _clearRows() {
            this.table.find('tbody').empty();
        }

        _addRow(label = '') {
            const tbody = this.table.find('tbody');
            const idx = tbody.children().length + 1;
            const row = $('<tr></tr>');
            row.append(`<td>${idx}</td>`);
            const input = $(`<input type="text" class="form-control form-control-sm" value="${label}">`);
            row.append($('<td></td>').append(input));
            const del = $('<button class="btn btn-danger btn-sm">✕</button>').on('click', () => { row.remove(); this._renumber(); });
            row.append($('<td></td>').append(del));
            tbody.append(row);
        }

        _renumber() {
            this.table.find('tbody tr').each((i, tr) => {
                $(tr).children().first().text(i + 1);
            });
        }

        async _loadHeaders() {
            this._clearRows();
            if (!this.settings.datasource) return;
            const dsSettings = freeboard.getDatasourceSettings(this.settings.datasource) || {};
            let headers = [];
            if (this.ipc) {
                try {
                    const path = await this._getPortPath();
                    headers = await this.ipc.invoke('get-serial-headers', { path });
                } catch (e) { /* ignore */ }
            }
            if (!Array.isArray(headers) || !headers.length) {
                if (Array.isArray(dsSettings.headers)) {
                    headers = dsSettings.headers.map(h => h.label);
                } else if (typeof dsSettings.headers === 'string') {
                    headers = dsSettings.headers.split(/[,;]+/).map(h => h.trim()).filter(Boolean);
                }
            }
            headers.forEach(h => this._addRow(h));
            if (headers.length === 0) this._addRow('');
        }

        async _save() {
            if (!this.settings.datasource) return;
            const labels = this.table.find('tbody input').map((_, el) => $(el).val().trim()).get();
            const clean = labels.filter(l => l);
            const newHeaders = clean.map(l => ({ label: l }));
            const dsSettings = freeboard.getDatasourceSettings(this.settings.datasource) || {};
            if (typeof freeboard.setDatasourceSettings === 'function') {
                freeboard.setDatasourceSettings(this.settings.datasource, { headers: newHeaders });
            }
            if (this.ipc) {
                try {
                    const path = await this._getPortPath();
                    await this.ipc.invoke('set-serial-headers', { path, headers: clean });
                } catch (e) { console.error('Failed to set headers', e); }
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

        onSettingsChanged(newSettings) {
            this.settings = newSettings;
            this._refreshDatasourceOptions();
            if (this.settings.datasource) {
                this.dsSelect.val(this.settings.datasource);
            }
            this._loadHeaders();
        }

        onDispose() {
            if (this._configHandler && freeboard.off) {
                freeboard.off('config_updated', this._configHandler);
            }
        }

        getHeight() { return 4; }
    }
}());
