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
            this.mode = 'serial'; // 'serial' | 'can'
            this.btnSerial = $('<button class="btn btn-outline-primary btn-sm active">Serial</button>');
            this.btnCan = $('<button class="btn btn-outline-primary btn-sm">CAN</button>');
            this.canSelect = $('<select class="form-select form-select-sm flex-fill" disabled></select>');
            this.refreshCanBtn = $('<button class="btn btn-secondary btn-sm" disabled>Refresh</button>');
            this.nodeSelect = $('<select class="form-select form-select-sm flex-fill" disabled></select>');
            this.refreshNodeBtn = $('<button class="btn btn-secondary btn-sm" disabled>Scan</button>');
            this.flashAllMode = false; // false: single target; true: all nodes
            this.flashModeBtn = $('<button class="btn btn-outline-secondary btn-sm" disabled>Flash all nodes</button>');
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
            this._refreshCan();
            this._refreshNodes();
            this.refreshBtn.on('click', () => this._refreshPorts());
            this.refreshCanBtn.on('click', () => this._refreshCan());
            this.refreshNodeBtn.on('click', () => this._refreshNodes(true));
            $(el).append(this.container);
            const modeRow = $('<div class="input-group input-group-sm mb-1 align-items-center"></div>');
            modeRow.append('<span class="input-group-text">Mode</span>');
            const modeBtns = $('<div class="btn-group" role="group"></div>');
            modeBtns.append(this.btnSerial, this.btnCan);
            modeRow.append(modeBtns);

            const portRow = $('<div class="input-group input-group-sm mb-1"></div>');
            portRow.append('<span class="input-group-text">Serial Port</span>', this.portSelect, this.refreshBtn);

            const canRow = $('<div class="input-group input-group-sm mb-1"></div>');
            canRow.append('<span class="input-group-text">CAN Interface</span>', this.canSelect, this.refreshCanBtn);

            const nodeRow = $('<div class="input-group input-group-sm mb-1 align-items-center"></div>');
            nodeRow.append('<span class="input-group-text">Target Node</span>', this.nodeSelect, this.refreshNodeBtn, this.flashModeBtn);

            const fileRow = $('<div class="input-group input-group-sm mb-1"></div>');
            fileRow.append(this.fileBtn, this.fileLabel);
            this.container.append(modeRow, portRow, canRow, nodeRow, fileRow, this.startBtn, this.cancelBtn, this.progressWrapper, this.logArea);

            // Toggle UI by mode (hide/show rows)
            const updateModeUI = () => {
                const useCan = (this.mode === 'can');
                // Button active state
                this.btnSerial.toggleClass('active', !useCan);
                this.btnCan.toggleClass('active', useCan);
                // Show/Hide relevant rows
                portRow.toggle(!useCan);
                canRow.toggle(useCan);
                nodeRow.toggle(useCan);
                // Also keep controls disabled when hidden for safety
                this.canSelect.prop('disabled', !useCan);
                this.refreshCanBtn.prop('disabled', !useCan);
                this.nodeSelect.prop('disabled', !useCan);
                this.refreshNodeBtn.prop('disabled', !useCan);
                this.flashModeBtn.prop('disabled', !useCan);
                this.portSelect.prop('disabled', useCan);
                this.refreshBtn.prop('disabled', useCan);
            };
            // Mode button handlers
            this.btnSerial.on('click', () => { this.mode = 'serial'; updateModeUI(); });
            this.btnCan.on('click', () => { this.mode = 'can'; updateModeUI(); });
            updateModeUI();

            // Toggle flash mode button
            this._updateFlashModeBtn = () => {
                if (this.flashAllMode) {
                    this.flashModeBtn.text('Flash selected device')
                        .removeClass('btn-outline-secondary').addClass('btn-primary');
                } else {
                    this.flashModeBtn.text('Flash all nodes')
                        .removeClass('btn-primary').addClass('btn-outline-secondary');
                }
            };
            this._updateFlashModeBtn();
            this.flashModeBtn.on('click', () => {
                this.flashAllMode = !this.flashAllMode;
                this._updateFlashModeBtn();
            });

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

        async _refreshCan() {
            if (!this.ipc) return;
            const ifs = await this.ipc.invoke('get-can-interfaces');
            this.canSelect.empty();
            const list = (ifs && ifs.length) ? ifs : [{ name: 'can0', value: 'can0' }];
            list.forEach(i => {
                this.canSelect.append(`<option value="${i.value}">${i.name}</option>`);
            });
            // Default select can0 if present
            const hasCan0 = list.some(i => i.value === 'can0');
            if (hasCan0) this.canSelect.val('can0');
        }

        async _refreshNodes(doScan = false) {
            if (!this.ipc) return;
            if (doScan) {
                try {
                    const channel = this.canSelect.val() || 'can0';
                    try { await this.ipc.invoke('can-open', { channel }); } catch {}
                    await this.ipc.invoke('can-scan-nodes', { channel });
                } catch (e) {
                    console.warn('CAN scan failed:', e?.message || e);
                }
            }
            const nodes = await this.ipc.invoke('get-thingset-nodes');
            this.nodeSelect.empty();
            nodes.forEach(n => {
                this.nodeSelect.append(`<option value="${n.value}">${n.name}</option>`);
            });
            const hasNodes = nodes && nodes.length > 0;
            this.flashModeBtn.prop('disabled', !hasNodes);
        }

        _startFlash() {
            const filePath = this.selectedFilePath;
            const useCan = (this.mode === 'can');
            const port = this.portSelect.val();
            const canIf = this.canSelect.val();
            const nodeAddrStr = this.nodeSelect.val();
            const nodeAddr = nodeAddrStr ? parseInt(nodeAddrStr, 10) : NaN;
            const flashAll = !!this.flashAllMode;

            if (!this.ipc) {
                this.logArea.val('Error: IPC unavailable.\n').show();
                return;
            }

            if (!filePath || (!useCan && !port) || (useCan && (!canIf || (!flashAll && isNaN(nodeAddr))))) {
                const msg = useCan ? 'Please select a firmware file, a CAN interface, and a target node (or switch to Flash all nodes).' : 'Please select both a firmware file and a port.';
                this.logArea.val(msg + '\n').show();
                return;
            }

            const fName = this.path ? this.path.basename(filePath) : filePath;
            this.logArea.val(`Flashing ${fName}...\n`).show();
            this.progressWrapper.show();
            this.progressWrapper.find('.progress-bar').css('width','0%').text('0%');
            this.startBtn.hide();
            this.cancelBtn.show();
            this.selectedFilePath = filePath;
            if (useCan) {
                if (flashAll) this._startFlashAllCan(canIf, filePath);
                else this._startFlashSingleCan(canIf, filePath, nodeAddr);
            } else {
                this.ipc.invoke('start-flash', { comPort: port, firmwarePath: filePath });
                this.ipc.once('flash-complete', this._completeListener);
            }
            this.ipc.on('flash-progress', this._progressListener);
        }

        _startFlashSingleCan(channel, filePath, nodeAddr) {
            const onCompleteOnce = () => {
                this._onComplete();
                this.ipc.removeListener('flash-complete', onCompleteOnce);
            };
            this.ipc.on('flash-complete', onCompleteOnce);
            this.ipc.invoke('start-flash-can', { channel, filename: filePath, target: nodeAddr });
        }

        async _startFlashAllCan(channel, filePath) {
            const nodes = await this.ipc.invoke('get-thingset-nodes');
            const addrs = (nodes || []).map(n => n.value).filter(v => Number.isFinite(v));
            if (!addrs.length) {
                this.logArea.val(this.logArea.val() + 'No nodes found to flash.\n');
                this._onComplete();
                return;
            }
            this._flashQueue = addrs.slice();
            this._flashingAll = true;
            this._cancelAll = false;

            const next = () => {
                if (this._cancelAll) { this._flashingAll = false; this._onComplete(); return; }
                const addr = this._flashQueue.shift();
                if (typeof addr === 'undefined') { this._flashingAll = false; this._onComplete(); return; }
                const hex = '0x' + addr.toString(16).toUpperCase().padStart(2, '0');
                this.logArea.val(this.logArea.val() + `\n=== Flashing node ${hex} ===\n`);
                const bar = this.progressWrapper.find('.progress-bar');
                bar.css('width','0%').text('0%');
                const onCompleteOnce = () => {
                    this.ipc.removeListener('flash-complete', onCompleteOnce);
                    setTimeout(() => next(), 300);
                };
                this.ipc.on('flash-complete', onCompleteOnce);
                this.ipc.invoke('start-flash-can', { channel, filename: filePath, target: addr });
            };
            next();
        }

        _cancelFlash() {
            if (!this.ipc) return;
            if (this.mode === 'can') {
                this._cancelAll = true;
                this.ipc.send('cancel-flash-can');
            }
            else this.ipc.send('cancel-flash');
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

        getHeight() { return 5; }
    }
})();
