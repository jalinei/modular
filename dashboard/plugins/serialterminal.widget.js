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
            this.container = $('<div class="d-flex flex-column h-100 gap-2 overflow-auto"></div>');
            this.dsSelect = $('<select class="form-select form-select-sm"></select>');
            this.colorCheck = $('<input class="form-check-input" type="checkbox">');
            const colorWrapper = $('<div class="form-check form-switch mb-2"></div>');
            colorWrapper.append(this.colorCheck).append('<label class="form-check-label">Colorize</label>');
            this.codeEl = $('<code></code>');
            this.preEl = $('<pre class="serial-terminal" style="overflow:auto; flex:1; margin:0;"></pre>').append(this.codeEl);
            this.container.append(this.dsSelect, colorWrapper, this.preEl);
            this._configHandler = () => this._refreshDatasourceOptions();
            freeboard.on && freeboard.on('config_updated', this._configHandler);
        }

        render(containerElement) {
            $(containerElement).append(this.container);
            this._refreshDatasourceOptions();
            this.dsSelect.on('change', () => {
                this.settings.datasourceName = this.dsSelect.val();
            });
            this.colorCheck.on('change', () => {
                this.settings.colorize = this.colorCheck.prop('checked');
            });
            this.colorCheck.prop('checked', !!this.settings.colorize);
            this.dsSelect.val(this.settings.datasourceName);
            this._updateTimer();
        }

        async _poll() {
            if (!this.ipcRenderer || !this.settings.datasourceName) return;
            const ds = freeboard.getDatasourceSettings(this.settings.datasourceName);
            if (!ds || !ds.portPath) return;
            try {
                const lines = await this.ipcRenderer.invoke("get-terminal-buffer", { path: ds.portPath });
                if (Array.isArray(lines)) {
                    const max = parseInt(this.settings.maxLines) || 100;
                    const display = lines.slice(-max);
                    if (this.settings.colorize !== false) {
                        const formatted = this._formatLines(display, ds.separator || ":");
                        this.codeEl.html(formatted.join("<br/>"));
                    } else {
                        this.codeEl.text(display.join("\n"));
                    }
                }
            } catch (e) {
                console.error("Terminal polling failed", e);
            }
        }

        _formatLines(lines, separator) {
            return lines.map(line => {
                const parts = line.trim().split(separator).filter(p => p !== "");
                return parts.map((p, idx) => {
                    const color = `hsl(${(idx * 60) % 360}, 70%, 50%)`;
                    return `<span style="color:${color}">${p}</span>`;
                }).join(" ");
            });
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