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
            }
        ],
        newInstance: function (settings, newInstanceCallback) {
            newInstanceCallback(new SerialCommandButtons(settings));
        }
    });

    class SerialCommandButtons {
        constructor(settings) {
            this.settings = settings;
            this.container = $('<div class="serial-command-buttons"></div>');
            this.ipcRenderer = window.require?.("electron")?.ipcRenderer;
        }

        render(containerElement) {
            $(containerElement).append(this.container);
            this._renderButtons();
        }

        _renderButtons() {
            this.container.empty();
            const layout = this.settings.layout || "vertical";
            const buttons = this.settings.buttons || [];
            buttons.forEach(cfg => {
                const btn = $('<button></button>')
                    .text(cfg.label || cfg.command)
                    .css({ margin: "2px", display: layout === "horizontal" ? "inline-block" : "block" });
                btn.on('click', () => this._sendCommand(cfg.command));
                this.container.append(btn);
            });
        }

        _sendCommand(command) {
            if (!this.ipcRenderer || !command) return;
            this.ipcRenderer.invoke("write-serial-port", { data: command })
                .catch(err => console.error("Serial command failed:", err));
        }

        onSettingsChanged(newSettings) {
            this.settings = newSettings;
            this._renderButtons();
        }

        onDispose() {}

        getHeight() {
            const count = Array.isArray(this.settings.buttons) ? this.settings.buttons.length : 1;
            if (this.settings.layout === "horizontal") {
                return 1;
            }
            return Math.max(1, count);
        }
    }
})();