(function () {
    const colorThemes = {
        ColorBlind10: ColorBlind10,
        OfficeClassic6: OfficeClassic6,
        HueCircle19: HueCircle19,
        Tableau20: Tableau20
    };

    freeboard.loadWidgetPlugin({
        type_name: "serial_header_editor",
        display_name: "Label and color editor",
        description: "Edit header labels for a datasource",
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
            this.paletteSelect = $('<select class="form-select form-select-sm flex-fill"></select>');
            Object.keys(colorThemes).forEach(k => {
                this.paletteSelect.append(`<option value="${k}">${k}</option>`);
            });
            this.rowsWrap = $('<div class="flex-fill overflow-auto"></div>');
            this.rows = $('<div class="d-flex flex-column"></div>');
            this.rowsWrap.append(this.rows);
            this.addBtn = $('<button class="btn btn-secondary btn-sm">Add Field</button>');
            this.saveBtn = $('<button class="btn btn-primary btn-sm">Save</button>');
            this._configHandler = () => this._refreshDatasourceOptions();
            freeboard.on && freeboard.on('config_updated', this._configHandler);
        }

        render(el) {
            $(el).append(this.container);
            const dsRow = $('<div class="input-group input-group-sm mb-1"></div>');
            dsRow.append('<span class="input-group-text">Datasource</span>', this.dsSelect);
            const palRow = $('<div class="input-group input-group-sm mb-1"></div>');
            palRow.append('<span class="input-group-text">Colors</span>', this.paletteSelect);
            const btnRow = $('<div class="d-flex gap-1"></div>').append(this.addBtn, this.saveBtn);
            this.container.append(dsRow, palRow, this.rowsWrap, btnRow);
           this.addBtn.on('click', () => this._addRow());
            this.saveBtn.on('click', () => this._save());
            this.dsSelect.on('change', () => {
                this.settings.datasource = this.dsSelect.val();
                this._loadHeaders();
            });
            this.paletteSelect.on('change', () => {
                this.settings.palette = this.paletteSelect.val();
                this._applyPalette();
            });
            this._refreshDatasourceOptions();
            if (this.settings.datasource) {
                this.dsSelect.val(this.settings.datasource);
            }
            this.paletteSelect.val(this.settings.palette || 'ColorBlind10');
            this._loadHeaders();
        }

        async _getPortPath() {
            const dsSettings = freeboard.getDatasourceSettings(this.settings.datasource) || {};
            return dsSettings.portPath || this.settings.datasource;
        }

        _getDatasourceType() {
            const live = freeboard.getLiveModel?.();
            if (!live || typeof live.datasources !== 'function') return null;
            const list = live.datasources();
            for (const ds of list) {
                try {
                    if (ds.name && ds.name() === this.settings.datasource) {
                        return ds.type?.();
                    }
                } catch (e) { /* ignore */ }
            }
            return null;
        }

        async _getChannelCount() {
            if (!this.ipc || !this.settings.datasource) return 0;
            try {
                const path = await this._getPortPath();
                const dsType = this._getDatasourceType();
                if (dsType === 'fast_frame_datasource') {
                    const dataset = await this.ipc.invoke('get-fast-dataset', { path });
                    if (dataset && Array.isArray(dataset.series)) return dataset.series.length;
                } else {
                    const data = await this.ipc.invoke('get-serial-buffer', { path });
                    if (Array.isArray(data)) return data.length;
                }
            } catch (e) { /* ignore */ }
            return 0;
        }

        _clearRows() {
            this.rows.empty();
        }

        _defaultColor(idx) {
            const pal = colorThemes[this.settings.palette] || colorThemes.ColorBlind10;
            return pal[idx % pal.length];
        }

        _addRow(label = '', color = null) {
            const idx = this.rows.children().length + 1;
            const clr = color || this._defaultColor(idx - 1);
            const row = $('<div class="input-group input-group-sm mb-1"></div>');
            row.append(`<span class="input-group-text">${idx}</span>`);
            const input = $(`<input type="text" class="form-control" value="${label}">`);
            row.append(input);
            const colorInput = $(`<input type="color" class="form-control form-control-color" value="${clr}" title="Choose color">`);
            row.append(colorInput);
            const del = $('<button class="btn btn-danger" type="button">✕</button>')
                .on('click', () => { row.remove(); this._renumber(); });
            row.append(del);
            this.rows.append(row);
        }

        _renumber() {
            this.rows.children().each((i, row) => {
                $(row).children('.input-group-text').first().text(i + 1);
            });
        }

        _applyPalette() {
            const pal = colorThemes[this.settings.palette] || colorThemes.ColorBlind10;
            this.rows.children().each((i, row) => {
                $(row).find("input[type='color']").val(pal[i % pal.length]);
            });
        }

        async _loadHeaders() {
            this._clearRows();
            if (!this.settings.datasource) return;
            const dsSettings = freeboard.getDatasourceSettings(this.settings.datasource) || {};
            let headers = [];
            let colors = [];
            if (this.ipc) {
                try {
                    const path = await this._getPortPath();
                    headers = await this.ipc.invoke('get-serial-headers', { path });
                    colors = await this.ipc.invoke('get-serial-colors', { path });
                } catch (e) { /* ignore */ }
            }
            if (!Array.isArray(headers) || !headers.length) {
                if (Array.isArray(dsSettings.headers)) {
                    headers = dsSettings.headers.map(h => h.label);
                    colors = dsSettings.headers.map(h => h.color || null);
                } else if (typeof dsSettings.headers === 'string') {
                    headers = dsSettings.headers.split(/[,;]+/).map(h => h.trim()).filter(Boolean);
                }
            }
            if (!Array.isArray(colors)) colors = [];

            const chanCount = await this._getChannelCount();
            const required = Math.max(chanCount, headers.length);
            for (let i = headers.length; i < required; i++) headers.push('');
            for (let i = colors.length; i < required; i++) colors.push(null);

            headers.forEach((h, i) => this._addRow(h, colors[i]));
            if (headers.length === 0) this._addRow();
            this._applyPalette();
        }

        async _save() {
            if (!this.settings.datasource) return;
            const rows = this.rows.children();
            const labels = [];
            const colors = [];
            rows.each((_, row) => {
                labels.push($(row).find('input[type="text"]').val().trim());
                colors.push($(row).find('input[type="color"]').val() || '#ff0000');
            });
            const clean = labels.slice();
            const newHeaders = labels.map((l, i) => ({ label: l, color: colors[i] }));
            const dsSettings = freeboard.getDatasourceSettings(this.settings.datasource) || {};
            if (typeof freeboard.setDatasourceSettings === 'function') {
                freeboard.setDatasourceSettings(this.settings.datasource, { headers: newHeaders });
            }
            if (this.ipc) {
                try {
                    const path = await this._getPortPath();
                    await this.ipc.invoke('set-serial-headers', { path, headers: clean });
                    await this.ipc.invoke('set-serial-colors', { path, colors });
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
                    const t = ds.type && ds.type();
                    if (t === 'serialport_datasource' || t === 'fast_frame_datasource') {
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
            this.paletteSelect.val(this.settings.palette || 'ColorBlind10');
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
