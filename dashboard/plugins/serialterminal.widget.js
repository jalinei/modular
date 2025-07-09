(function () {
    freeboard.loadWidgetPlugin({
        type_name: "serial_terminal",
        display_name: "Serial Terminal",
        description: "Show live data from a serial datasource",
        settings: [
            { name: "title", display_name: "Title", type: "text" },
            { name: "datasourceName", display_name: "Datasource Name", type: "text" },
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
            this.container = $('<pre class="serial-terminal" style="overflow:auto; height:100%;"></pre>');
            this.ipcRenderer = window.require?.("electron")?.ipcRenderer;
            this.timer = null;
        }

        render(containerElement) {
            $(containerElement).append(this.container);
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
                    const formatted = this._formatLines(display, ds.separator || ":");
                    this.container.html(formatted.join("<br/>"));
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

        _updateTimer() {
            if (this.timer) clearInterval(this.timer);
            const interval = parseInt(this.settings.refresh) || 1000;
            this.timer = setInterval(() => this._poll(), interval);
        }

        onSettingsChanged(newSettings) {
            this.settings = newSettings;
            this._updateTimer();
        }

        onDispose() { if (this.timer) clearInterval(this.timer); }

        getHeight() { return 4; }
    }
}());