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
            this.container = $('<div style="display:flex; flex-direction:column; gap:4px; height:100%; overflow:hidden;"></div>');
            this.dsSelect = $('<select style="width:100%; box-sizing:border-box;"></select>');
            this.tableWrap = $('<div style="flex:1; overflow:auto;"></div>');
            this.table = $('<table style="width:100%; font-size:12px; table-layout:fixed;" border="1" cellspacing="0" cellpadding="4"><thead><tr><th style=\"width:30px\">#</th><th>Label</th><th style=\"width:30px\"></th></tr></thead><tbody></tbody></table>');
            this.addBtn = $('<button>Add Field</button>');
            this.saveBtn = $('<button>Save</button>');
            this._configHandler = () => this._refreshDatasourceOptions();
            freeboard.on && freeboard.on('config_updated', this._configHandler);
        }

        render(el) {
            $(el).append(this.container);
            this.container.append(this.dsSelect, this.tableWrap, this.addBtn, this.saveBtn);
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
            const input = $(`<input type="text" style="width:100%; box-sizing:border-box;" value="${label}">`);
            row.append($('<td></td>').append(input));
            const del = $('<button>✕</button>').on('click', () => { row.remove(); this._renumber(); });
            row.append($('<td></td>').append(del));
            tbody.append(row);
        }

        _renumber() {
            this.table.find('tbody tr').each((i, tr) => {
                $(tr).children().first().text(i + 1);
            });
        }

        async _detectChannelCount() {
            if (!this.ipc) return null;
            try {
                const path = await this._getPortPath();
                const sample = await this.ipc.invoke('get-serial-buffer', { path });
                if (Array.isArray(sample)) return sample.length;
            } catch (e) { /* ignore */ }
            return null;
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

            if (Array.isArray(headers) && headers.length) {
                headers.forEach(h => this._addRow(h));
            } else {
                let count = await this._detectChannelCount();
                if (!count || count < 1) count = 16;
                for (let i = 0; i < count; i++) this._addRow('');
            }
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
