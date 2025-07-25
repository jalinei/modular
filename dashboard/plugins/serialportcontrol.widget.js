(function () {
    freeboard.loadWidgetPlugin({
        type_name: "serial_port_control",
        display_name: "Serial Port Control",
        description: "Open/close and clear a serial datasource",
        settings: [
            { name: "datasource", display_name: "Datasource Name", type: "text" }
        ],
        newInstance: function (settings, newInstanceCallback) {
            newInstanceCallback(new SerialPortControl(settings));
        }
    });

    class SerialPortControl {
        constructor(settings) {
            this.settings = settings;
            this.ipc = window.require?.("electron")?.ipcRenderer;
            this.container = $('<div class="d-flex flex-column h-100 gap-2 overflow-auto"></div>');
            this.dsSelect = $('<select class="form-select form-select-sm flex-fill"></select>');
            this.toggleBtn = $('<button class="btn btn-primary btn-sm w-100"></button>');
            this.clearBtn = $('<button class="btn btn-secondary btn-sm w-100">Clear</button>');
            this.isOpen = false;
            this.timer = null;
            this._configHandler = () => this._refreshDatasourceOptions();
            freeboard.on && freeboard.on('config_updated', this._configHandler);
        }

        render(el) {
            $(el).append(this.container);
            const dsRow = $('<div class="input-group input-group-sm mb-1"></div>');
            dsRow.append('<span class="input-group-text">Datasource</span>', this.dsSelect);
            this.container.append(dsRow, this.toggleBtn, this.clearBtn);
            this.dsSelect.on('change', () => {
                this.settings.datasource = this.dsSelect.val();
                this._updateStatus();
            });
            this.toggleBtn.on('click', () => this._togglePort());
            this.clearBtn.on('click', () => this._flushBuffers());
            this._refreshDatasourceOptions();
            if (this.settings.datasource) {
                this.dsSelect.val(this.settings.datasource);
            }
            this._updateStatus();
            this.timer = setInterval(() => this._updateStatus(), 1000);
        }

        async _refreshDatasourceOptions() {
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

        async _getPortPath() {
            const dsSettings = freeboard.getDatasourceSettings(this.settings.datasource) || {};
            return dsSettings.portPath || this.settings.datasource;
        }

        async _updateStatus() {
            if (!this.ipc || !this.settings.datasource) return;
            const path = await this._getPortPath();
            try {
                this.isOpen = await this.ipc.invoke('is-serial-port-open', { path });
            } catch (e) {
                this.isOpen = false;
            }
            this.toggleBtn.text(this.isOpen ? 'Pause' : 'Open');
        }

        async _togglePort() {
            if (!this.ipc || !this.settings.datasource) return;
            const dsSettings = freeboard.getDatasourceSettings(this.settings.datasource) || {};
            const path = dsSettings.portPath || this.settings.datasource;
            if (this.isOpen) {
                await this.ipc.invoke('close-serial-port', { path }).catch(() => {});
                this.isOpen = false;
            } else {
                await this.ipc.invoke('open-serial-port', {
                    path,
                    baudRate: dsSettings.baudRate,
                    separator: dsSettings.separator,
                    eol: dsSettings.eol,
                    type: 'serialport_datasource'
                }).catch(() => {});
                this.isOpen = true;
            }
            this.toggleBtn.text(this.isOpen ? 'Pause' : 'Open');
        }

        async _flushBuffers() {
            if (!this.ipc || !this.settings.datasource) return;
            const path = await this._getPortPath();
            await this.ipc.invoke('flush-serial-buffers', { path }).catch(() => {});
        }

        onSettingsChanged(newSettings) {
            this.settings = newSettings;
            this._refreshDatasourceOptions();
            if (this.settings.datasource) {
                this.dsSelect.val(this.settings.datasource);
            }
            this._updateStatus();
        }

        onDispose() {
            if (this.timer) clearInterval(this.timer);
            if (this._configHandler && freeboard.off) {
                freeboard.off('config_updated', this._configHandler);
            }
        }

        getHeight() { return 3; }
    }
})();

