(function () {
        const COLOR_PALETTES = {
                default: [
                        "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231",
                        "#911eb4", "#46f0f0", "#f032e6", "#bcf60c", "#fabebe"
                ],
                pastel: [
                        "#ffb3ba", "#ffdfba", "#ffffba", "#baffc9", "#bae1ff"
                ],
                dark: [
                        "#800000", "#9a6324", "#808000", "#469990", "#000075",
                        "#e6194b", "#911eb4", "#a9a9a9", "#fffac8", "#aaffc3"
                ]
        };

        var serialDatasource = function (settings, updateCallback) {
                var self = this;
                var currentSettings = settings;
                var timer;
                const ipcRenderer = window.require?.("electron")?.ipcRenderer;
                let latestData = [];

                let palette = COLOR_PALETTES[currentSettings.palette] || COLOR_PALETTES.default;

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
                        const names = [];
                        const colors = [];
                        latestData.forEach((val, idx) => {
                                data[`y${idx + 1}`] = val;
                                const cfg = Array.isArray(currentSettings.channels) ? currentSettings.channels[idx] || {} : {};
                                names.push(cfg.name || `ch${idx + 1}`);
                                const clr = cfg.color && cfg.color.trim() ? cfg.color : palette[idx % palette.length];
                                colors.push(clr);
                        });
                        data.channelNames = names;
                        data.channelColors = colors;
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
                        palette = COLOR_PALETTES[currentSettings.palette] || COLOR_PALETTES.default;
                        updateTimer();
                        openPort();
                        // push metadata immediately so widgets refresh even before new data arrives
                        self.updateNow();
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
                                name: "refresh",
                                display_name: "Refresh Every",
                                type: "number",
                                suffix: "ms",
                                default_value: 1000
                        },
                        {
                                name: "palette",
                                display_name: "Color Palette",
                                type: "option",
                                options: [
                                        { name: "Default", value: "default" },
                                        { name: "Pastel", value: "pastel" },
                                        { name: "Dark", value: "dark" }
                                ],
                                default_value: "default"
                        },
                        {
                                name: "channels",
                                display_name: "Channels",
                                type: "array",
                                settings: [
                                        { name: "name", display_name: "Name", type: "text" },
                                        {
                                                name: "color",
                                                display_name: "Color",
                                                type: "text",
                                                description: "Any CSS color value (e.g. '#ff0000' or 'hsl(120,100%,50%)')"
                                        }
                                ]
                        }
                ],
		newInstance: function (settings, newInstanceCallback, updateCallback) {
			newInstanceCallback(new serialDatasource(settings, updateCallback));
		}
	});
}());
