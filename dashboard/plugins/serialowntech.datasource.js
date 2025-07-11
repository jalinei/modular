(function () {
	var serialDatasource = function (settings, updateCallback) {
		var self = this;
		var currentSettings = settings;
                var timer;
                const ipcRenderer = window.require?.("electron")?.ipcRenderer;
                let latestData = [];
                function parseHeaders(input) {
                        if (Array.isArray(input)) {
                                return input.map(obj => typeof obj === "string" ? obj : obj.label).filter(Boolean);
                        }
                        return String(input || "").split(/[,;]+/).map(h => h.trim()).filter(h => h);
                }

                let headers = parseHeaders(currentSettings.headers);

                function ensureHeaderCount(count) {
                        if (headers.length >= count) return;
                        for (let i = headers.length; i < count; i++) {
                                headers.push(`ch${i + 1}`);
                        }
                        currentSettings.headers = headers.map(label => ({ label }));

                        if (typeof freeboard?.getDatasourceSettings === "function" && typeof freeboard?.setDatasourceSettings === "function") {
                                const live = freeboard.getLiveModel?.();
                                const list = live?.datasources?.();
                                if (Array.isArray(list)) {
                                        for (const ds of list) {
                                                try {
                                                        if (ds.settings().portPath === currentSettings.portPath && ds.type() === "serialport_datasource") {
                                                                const name = ds.name();
                                                                freeboard.setDatasourceSettings(name, { headers: currentSettings.headers });
                                                                break;
                                                        }
                                                } catch (e) { /* ignore */ }
                                        }
                                }
                        }
                }

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
                                const data = await ipcRenderer.invoke("get-serial-buffer");
                                if (Array.isArray(data)) {
                                        latestData = data;
                                        ensureHeaderCount(latestData.length);
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
                        ensureHeaderCount(latestData.length);
			const data = {
				numeric_value: date.getTime(),
				full_string_value: date.toLocaleString(),
				date_string_value: date.toLocaleDateString(),
				time_string_value: date.toLocaleTimeString(),
				date_object: date
			};
                        const headerMap = {};
                        latestData.forEach((val, idx) => {
                                const key = `y${idx + 1}`;
                                data[key] = val;
                                if (headers[idx]) {
                                        headerMap[key] = headers[idx];
                                }
                        });
                        data.headers = headerMap;
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
                        headers = parseHeaders(currentSettings.headers);
                        updateTimer();
                        openPort();
                };

		stopTimer();
		updateTimer();
		openPort();
	};

	freeboard.loadDatasourcePlugin({
		type_name: "serialport_datasource",
		display_name: "Serial Port Reader",
		description: "Reads data from a serial port",
		settings: [
			{
				name: "portPath",
				display_name: "Port Path",
				type: "text",
				default_value: "/dev/ttyACM0"
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
                                name: "headers",
                                display_name: "Headers",
                                type: "array",
                                settings: [
                                        { name: "label", display_name: "Label", type: "text" }
                                ],
                                description: "Labels for each value in the data array"
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
}());
