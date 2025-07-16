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
            this.container = $('<div class="serial-command-buttons d-flex flex-column gap-2 overflow-auto"></div>');
            this.dsSelect = $('<select class="form-select form-select-sm flex-fill"></select>');
            this.btnContainer = $('<div class="d-flex flex-wrap"></div>');
            this._configHandler = () => this._refreshDatasourceOptions();
            freeboard.on && freeboard.on('config_updated', this._configHandler);
        }

        render(containerElement) {
            $(containerElement).append(this.container);
            const dsRow = $('<div class="input-group input-group-sm mb-2"></div>');
            dsRow.append('<span class="input-group-text">Datasource</span>', this.dsSelect);
            this.container.append(dsRow, this.btnContainer);
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
            this.btnContainer.toggleClass('flex-column', layout !== 'horizontal');
            this.btnContainer.toggleClass('flex-row', layout === 'horizontal');
            buttons.forEach(cfg => {
                const btn = $('<button class="btn btn-primary btn-sm"></button>')
                    .text(cfg.label || cfg.command);
                if (layout === "horizontal") {
                    btn.addClass('me-1 mb-1');
                } else {
                    btn.addClass('mb-1 w-100');
                }
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