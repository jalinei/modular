(function () {
    freeboard.loadWidgetPlugin({
        type_name: "serial_command_buttons",
        display_name: "Serial Command Buttons",
        description: "Buttons to send commands over a serial port",
        settings: [
            {
                name: "buttons",
                display_name: "Buttons",
                type: "array",
                settings: [
                    { name: "label", display_name: "Label", type: "text" },
                    { name: "command", display_name: "Command", type: "text" }
                ]
            },
            {
                name: "layout",
                display_name: "Layout",
                type: "option",
                options: [
                    { name: "Vertical", value: "vertical" },
                    { name: "Horizontal", value: "horizontal" }
                ],
                default_value: "vertical"
            },
            {
                name: "datasource",
                display_name: "Datasource Name",
                type: "text"
            }
        ],
        newInstance: function (settings, newInstanceCallback) {
            newInstanceCallback(new SerialCommandButtons(settings));
        }
    });

    class SerialCommandButtons {
        constructor(settings) {
            this.settings = settings;
            this.ipcRenderer = window.require?.("electron")?.ipcRenderer;
            this.container = $('<div class="serial-command-buttons" style="display:flex; flex-direction:column; gap:4px;"></div>');
            this.dsSelect = $('<select style="width:100%; box-sizing:border-box;"></select>');
            this.btnContainer = $('<div></div>');
            this._configHandler = () => this._refreshDatasourceOptions();
            freeboard.on && freeboard.on('config_updated', this._configHandler);
        }

        render(containerElement) {
            $(containerElement).append(this.container);
            this.container.append(this.dsSelect, this.btnContainer);
            this.dsSelect.on('change', () => {
                this.settings.datasource = this.dsSelect.val();
            });
            this._refreshDatasourceOptions();
            if (this.settings.datasource) {
                this.dsSelect.val(this.settings.datasource);
            }
            this._renderButtons();
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

        _renderButtons() {
            this.btnContainer.empty();
            const layout = this.settings.layout || "vertical";
            const buttons = this.settings.buttons || [];
            buttons.forEach(cfg => {
                const btn = $('<button></button>')
                    .text(cfg.label || cfg.command)
                    .css({
                        margin: "2px",
                        display: layout === "horizontal" ? "inline-block" : "block",
                        width: layout === "horizontal" ? "80px" : "100%",
                        height: "32px",
                        boxSizing: "border-box"
                    });
                btn.on('click', () => this._sendCommand(cfg.command));
                this.btnContainer.append(btn);
            });
        }

        _sendCommand(command) {
            if (!this.ipcRenderer || !command) return;
            const dsSettings = freeboard.getDatasourceSettings(this.settings.datasource) || {};
            const path = dsSettings.portPath || this.settings.datasource;
            const payload = { data: command };
            if (path) payload.path = path;
            this.ipcRenderer.invoke("write-serial-port", payload)
                .catch(err => console.error("Serial command failed:", err));
        }

        onSettingsChanged(newSettings) {
            this.settings = newSettings;
            this._refreshDatasourceOptions();
            this._renderButtons();
        }

        onDispose() {
            if (this._configHandler && freeboard.off) {
                freeboard.off('config_updated', this._configHandler);
            }
        }

        getHeight() {
            const count = Array.isArray(this.settings.buttons) ? this.settings.buttons.length : 1;
            let rows = 1; // datasource selector row
            if (this.settings.layout === "horizontal") {
                rows += 1;
            } else {
                rows += Math.max(1, count);
            }
            return rows;
        }
    }
})();