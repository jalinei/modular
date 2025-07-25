(function () {
    freeboard.loadWidgetPlugin({
        type_name: "serial_terminal",
        display_name: "Serial Terminal",
        description: "Show live data from a serial datasource",
        settings: [
            { name: "title", display_name: "Title", type: "text" },
            { name: "datasourceName", display_name: "Datasource Name", type: "text" },
            { name: "colorize", display_name: "Colorize", type: "boolean", default_value: true },
            { name: "refresh", display_name: "Refresh (ms)", type: "number", default_value: 500 },
            { name: "maxLines", display_name: "Max Lines", type: "number", default_value: 100 }
        ],
        newInstance: function (settings, newInstanceCallback) {
            newInstanceCallback(new SerialTerminal(settings));
        }
    });

    class SerialTerminal {
        constructor(settings) {
            this.settings = settings;
            this.ipcRenderer = window.require?.("electron")?.ipcRenderer;
            this.timer = null;
            this.colors = [];
            this.lastColorCheck = 0;
            this.container = $('<div class="d-flex flex-column h-100 gap-2 overflow-auto"></div>');
            this.dsSelect = $('<select class="form-select form-select-sm flex-fill"></select>');
            const colorId = `chk_${Math.random().toString(36).slice(2)}`;
            this.colorCheck = $('<input class="form-check-input mt-0" type="checkbox">').attr('id', colorId);
            const colorWrapper = $('<div class="input-group input-group-sm mb-1"></div>');
            const colorLabel = $(`<label class="input-group-text" for="${colorId}">Colorize</label>`);
            const colorBox = $('<span class="input-group-text"></span>').append(this.colorCheck);
            colorWrapper.append(colorLabel).append(colorBox);
            this.codeEl = $('<code></code>');
            this.preEl = $(
                '<pre class="serial-terminal border border-secondary rounded bg-dark text-light p-2" ' +
                'style="overflow:auto; flex:1; margin:0;"></pre>'
            ).append(this.codeEl);
            const dsRow = $('<div class="input-group input-group-sm mb-1"></div>');
            dsRow.append('<span class="input-group-text">Datasource</span>', this.dsSelect);
            this.container.append(dsRow, colorWrapper, this.preEl);
            this._configHandler = () => this._refreshDatasourceOptions();
            freeboard.on && freeboard.on('config_updated', this._configHandler);
        }

        render(containerElement) {
            $(containerElement).append(this.container);
            this._refreshDatasourceOptions();
            this.dsSelect.on('change', () => {
                this.settings.datasourceName = this.dsSelect.val();
                this._refreshColors(true);
            });
            this.colorCheck.on('change', () => {
                this.settings.colorize = this.colorCheck.prop('checked');
            });
            this.colorCheck.prop('checked', !!this.settings.colorize);
            this.dsSelect.val(this.settings.datasourceName);
            this._refreshColors(true);
            this._updateTimer();
        }

        async _poll() {
            if (!this.ipcRenderer || !this.settings.datasourceName) return;
            const ds = freeboard.getDatasourceSettings(this.settings.datasourceName);
            if (!ds || !ds.portPath) return;
            await this._refreshColors();
            try {
                const lines = await this.ipcRenderer.invoke("get-terminal-buffer", { path: ds.portPath });
                if (Array.isArray(lines)) {
                    const max = parseInt(this.settings.maxLines) || 100;
                    const display = lines.slice(-max);
                    if (this.settings.colorize !== false) {
                        const formatted = this._formatLines(display, ds.separator || ":", this.colors);
                        this.codeEl.html(formatted.join("<br/>"));
                    } else {
                        this.codeEl.text(display.join("\n"));
                    }
                }
            } catch (e) {
                console.error("Terminal polling failed", e);
            }
        }

        _formatLines(lines, separator, colors = []) {
            return lines.map(line => {
                const parts = line.trim().split(separator).filter(p => p !== "");
                return parts.map((p, idx) => {
                    const color = colors[idx] || (typeof ColorBlind10 !== "undefined" ? ColorBlind10[idx % ColorBlind10.length] : `hsl(${(idx * 60) % 360}, 70%, 50%)`);
                    return `<span style="color:${color}">${p}</span>`;
                }).join(" ");
            });
        }

        async _refreshColors(force = false) {
            const now = Date.now();
            if (!force && now - this.lastColorCheck < 1000) return;
            this.lastColorCheck = now;
            if (!this.ipcRenderer || !this.settings.datasourceName) {
                this.colors = [];
                return;
            }
            const ds = freeboard.getDatasourceSettings(this.settings.datasourceName) || {};
            const path = ds.portPath || this.settings.datasourceName;
            const type = this._getDatasourceType(this.settings.datasourceName);
            try {
                const fetched = await this.ipcRenderer.invoke('get-serial-colors', { path, type });
                if (Array.isArray(fetched) && fetched.length) {
                    this.colors = fetched;
                    return;
                }
            } catch (e) { /* ignore */ }
            if (Array.isArray(ds.headers)) {
                this.colors = ds.headers.map(h => h.color || null);
            } else {
                this.colors = [];
            }
        }

        _refreshDatasourceOptions() {
            const live = freeboard.getLiveModel?.();
            if (!live || typeof live.datasources !== 'function') return;
            const list = live.datasources();
            const current = this.settings.datasourceName;
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

        _getDatasourceType(name) {
            const live = freeboard.getLiveModel?.();
            if (!live || typeof live.datasources !== 'function') return null;
            const list = live.datasources();
            for (const ds of list) {
                try {
                    if (ds.name && ds.name() === name) {
                        return ds.type?.();
                    }
                } catch (e) { /* ignore */ }
            }
            return null;
        }

        _updateTimer() {
            if (this.timer) clearInterval(this.timer);
            const interval = parseInt(this.settings.refresh) || 1000;
            this.timer = setInterval(() => this._poll(), interval);
        }

        onSettingsChanged(newSettings) {
            this.settings = newSettings;
            this.colorCheck.prop('checked', !!this.settings.colorize);
            this._refreshDatasourceOptions();
            this.dsSelect.val(this.settings.datasourceName);
            this._refreshColors(true);
            this._updateTimer();
        }

        onDispose() {
            if (this.timer) clearInterval(this.timer);
            if (this._configHandler && freeboard.off) {
                freeboard.off('config_updated', this._configHandler);
            }
        }

        getHeight() { return 4; }
    }
}());