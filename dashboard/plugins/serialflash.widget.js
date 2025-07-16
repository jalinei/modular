(function () {
    freeboard.loadWidgetPlugin({
        type_name: 'serial_flasher',
        display_name: 'Firmware Flasher',
        description: 'Flash firmware to a device over serial using mcumgr',
        settings: [
            { name: 'title', display_name: 'Title', type: 'text' }
        ],
        newInstance: function (settings, newInstanceCallback) {
            newInstanceCallback(new SerialFlasher(settings));
        }
    });

    class SerialFlasher {
        constructor(settings) {
            this.settings = settings;
            this.ipc = window.require?.('electron')?.ipcRenderer;
            this.path = window.require?.('path');
            this.container = $('<div class="d-flex flex-column h-100 gap-2 overflow-auto"></div>');
            this.portSelect = $('<select class="form-select form-select-sm flex-fill"></select>');
            this.refreshBtn = $('<button class="btn btn-secondary btn-sm">Refresh</button>');
            this.fileLabel = $('<input type="text" class="form-control form-control-sm" readonly value="No file selected">');
            this.fileBtn = $('<button class="btn btn-secondary btn-sm">Browse</button>');
            this.selectedFilePath = null;
            this.startBtn = $('<button class="btn btn-primary btn-sm">Flash Firmware</button>');
            this.cancelBtn = $('<button class="btn btn-danger btn-sm" style="display:none;">Cancel</button>');
            this.progressWrapper = $('<div class="progress" style="height:20px; display:none;"><div class="progress-bar" role="progressbar" style="width:0%"></div></div>');
            this.logArea = $('<textarea class="form-control bg-dark text-light" readonly style="flex:1; display:none;"></textarea>');
            this._progressListener = (_e, m) => this._onProgress(m);
            this._completeListener = () => this._onComplete();
        }

        render(el) {
            this._refreshPorts();
            this.refreshBtn.on('click', () => this._refreshPorts());
            $(el).append(this.container);
            const portRow = $('<div class="input-group input-group-sm mb-2"></div>');
            portRow.append('<span class="input-group-text">Port</span>', this.portSelect, this.refreshBtn);
            const fileRow = $('<div class="input-group input-group-sm mb-2"></div>');
            fileRow.append(this.fileBtn, this.fileLabel);
            this.container.append(portRow, fileRow, this.startBtn, this.cancelBtn, this.progressWrapper, this.logArea);

            this.fileBtn.on('click', async () => {
                if (!this.ipc) return;
                const chosen = await this.ipc.invoke('choose-firmware-file');
                if (chosen) {
                    this.selectedFilePath = chosen;
                    const name = this.path ? this.path.basename(chosen) : chosen;
                    this.fileLabel.val(name);
                }
            });
            this.startBtn.on('click', () => this._startFlash());
            this.cancelBtn.on('click', () => this._cancelFlash());
        }

        async _refreshPorts() {
            if (!this.ipc) return;
            const ports = await this.ipc.invoke('get-serial-ports');
            this.portSelect.empty();
            ports.forEach(p => {
                this.portSelect.append(`<option value="${p.value}">${p.name}</option>`);
            });
        }

        _startFlash() {
            const filePath = this.selectedFilePath;
            const port = this.portSelect.val();

            if (!this.ipc) {
                this.logArea.val('Error: IPC unavailable.\n').show();
                return;
            }

            if (!filePath || !port) {
                this.logArea
                    .val('Please select both a firmware file and a port.\n')
                    .show();
                return;
            }

            const fName = this.path ? this.path.basename(filePath) : filePath;
            this.logArea.val(`Flashing ${fName}...\n`).show();
            this.progressWrapper.show();
            this.progressWrapper.find('.progress-bar').css('width','0%').text('0%');
            this.startBtn.hide();
            this.cancelBtn.show();
            this.selectedFilePath = filePath;
            this.ipc.invoke('start-flash', { comPort: port, firmwarePath: filePath });
            this.ipc.on('flash-progress', this._progressListener);
            this.ipc.once('flash-complete', this._completeListener);
        }

        _cancelFlash() {
            if (!this.ipc) return;
            this.ipc.send('cancel-flash');
            this.logArea.val(this.logArea.val() + 'Flash cancelled by user.\n');
        }

        _onProgress(message) {
            const bar = this.progressWrapper.find('.progress-bar');
            this.logArea.val(this.logArea.val() + message + '\n');
            this.logArea.scrollTop(this.logArea[0].scrollHeight);
            const m = message.match(/(\d{1,3}(?:\.\d+)?)%/);
            if (m) {
                const p = parseFloat(m[1]);
                bar.css('width', p + '%');
                bar.text(m[1] + '%');
            }
        }

        _onComplete() {
            this.startBtn.show();
            this.cancelBtn.hide();
        }

        onSettingsChanged(newSettings) {
            this.settings = newSettings;
        }

        onDispose() {
            if (this.ipc) {
                this.ipc.removeListener('flash-progress', this._progressListener);
                this.ipc.removeListener('flash-complete', this._completeListener);
            }
        }

        getHeight() { return 4; }
    }
})();

