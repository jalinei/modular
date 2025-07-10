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
            this.container = $('<div style="display:flex; flex-direction:column; height:100%; gap:4px;"></div>');
            this.portSelect = $('<select style="width:100%; box-sizing:border-box;"></select>');
            this.refreshBtn = $('<button>Refresh Ports</button>');
            this.fileLabel = $('<span>No file selected</span>');
            this.fileBtn = $('<button>Select Firmware</button>');
            this.selectedFilePath = null;
            this.startBtn = $('<button>Flash Firmware</button>');
            this.cancelBtn = $('<button style="display:none;">Cancel</button>');
            this.progressWrapper = $('<div class="progress" style="height:20px; display:none;"><div class="progress-bar" style="width:0%"></div></div>');
            this.logArea = $('<textarea readonly style="flex:1; width:100%; display:none; box-sizing:border-box;"></textarea>');
            this._progressListener = (_e, m) => this._onProgress(m);
            this._completeListener = () => this._onComplete();
        }

        render(el) {
            this._refreshPorts();
            this.refreshBtn.on('click', () => this._refreshPorts());
            $(el).append(this.container);
            const fileRow = $('<div style="display:flex; gap:4px;"></div>');
            fileRow.append(this.fileBtn, this.fileLabel);
            this.container.append(this.portSelect, this.refreshBtn, fileRow, this.startBtn, this.cancelBtn, this.progressWrapper, this.logArea);

            this.fileBtn.on('click', async () => {
                if (!this.ipc) return;
                const chosen = await this.ipc.invoke('choose-firmware-file');
                if (chosen) {
                    this.selectedFilePath = chosen;
                    const name = this.path ? this.path.basename(chosen) : chosen;
                    this.fileLabel.text(name);
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

