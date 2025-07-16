(function () {
        const ipcRenderer = window.require?.("electron")?.ipcRenderer;
        var serialDatasource = function (settings, updateCallback) {
                var self = this;
                var currentSettings = settings;
                var timer;
                // ipcRenderer is defined above
                let latestData = [];

		const eol = unescape(currentSettings.eol || "\\n");
		const sep = currentSettings.separator || ":";

		async function openPort() {
			if (!ipcRenderer) return;
			try {
				await ipcRenderer.invoke("open-serial-port", {
					path: currentSettings.portPath,
					baudRate: currentSettings.baudRate,
					separator: currentSettings.separator,
					eol: currentSettings.eol
				});
			} catch (e) {
				console.error("Open serial failed:", e.message);
			}
		}

                async function pollData() {
                        try {
                                const data = await ipcRenderer.invoke("get-serial-buffer", { path: currentSettings.portPath });
                                if (Array.isArray(data)) {
                                        latestData = data;
                                }
                        } catch (err) {
                                console.error("Failed to poll serial data:", err);
                        }
                }

		function stopTimer() {
			if (timer) {
				clearTimeout(timer);
				timer = null;
			}
		}

		function updateTimer() {
			stopTimer();
			let interval = parseFloat(currentSettings.refresh);
			if (isNaN(interval) || interval < 50) interval = 1000; // min 50 ms
			timer = setInterval(() => {
				self.updateNow();
			}, interval);
		}

		this.updateNow = async function () {
			const date = new Date();
                        await pollData();
                        const data = {
                                numeric_value: date.getTime(),
                                full_string_value: date.toLocaleString(),
                                date_string_value: date.toLocaleDateString(),
                                time_string_value: date.toLocaleTimeString(),
                                date_object: date
                        };
                        latestData.forEach((val, idx) => {
                                const key = `y${idx + 1}`;
                                data[key] = val;
                        });
                        updateCallback(data);
                };

		this.onDispose = function () {
			stopTimer();
			if (ipcRenderer && currentSettings.portPath) {
				ipcRenderer.invoke("close-serial-port", {
					path: currentSettings.portPath
				}).then(() => {
					console.log("🔌 Serial port closed via IPC.");
				}).catch(err => {
					console.error("❌ Failed to close port:", err);
				});
			}
		};

               this.onSettingsChanged = function (newSettings) {
                       currentSettings = newSettings;
                       updateTimer();
                       openPort();
               };

		stopTimer();
		updateTimer();
		openPort();
	};

        async function registerPlugin() {
                let portOptions = [];
                if (ipcRenderer) {
                        try {
                                const ports = await ipcRenderer.invoke('get-serial-ports');
                                portOptions = ports.map(p => ({ name: p.name, value: p.value }));
                        } catch (e) {
                                console.error('Failed to list serial ports', e);
                        }
                }

                freeboard.loadDatasourcePlugin({
                        type_name: "serialport_datasource",
                        display_name: "Serial Port Reader",
                        description: "Reads data from a serial port",
                        settings: [
                                {
                                        name: "portPath",
                                        display_name: "Port",
                                        type: "option",
                                        options: portOptions,
                                        default_value: portOptions.length ? portOptions[0].value : ""
                                },
			{
				name: "baudRate",
				display_name: "Baud Rate",
				type: "number",
				default_value: 115200
			},
			{
				name: "separator",
				display_name: "Separator",
				type: "text",
				default_value: ":"
			},
                        {
                                name: "eol",
                                display_name: "End of Line",
                                type: "text",
                                default_value: "\\r\\n"
                        },
                        {
                                name: "refresh",
                                display_name: "Refresh Every",
                                type: "number",
                                suffix: "ms",
				default_value: 1000
			}
		],
                newInstance: function (settings, newInstanceCallback, updateCallback) {
                        newInstanceCallback(new serialDatasource(settings, updateCallback));
                }
        });
        }

        registerPlugin();
}());
