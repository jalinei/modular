(function () {
    freeboard.loadWidgetPlugin({
        type_name: "owntech_plot_uplot",
        display_name: "OwnTech Plot (uPlot)",
        description: "Realtime uPlot-based chart for OwnTech",
        external_scripts: [
            "https://cdn.jsdelivr.net/npm/uplot@1.6.24/dist/uPlot.iife.min.js",
            "https://cdn.jsdelivr.net/npm/uplot@1.6.24/dist/uPlot.min.css"
        ],
        settings: [
            { name: "title", display_name: "Title", type: "text" },
            { name: "data", display_name: "Data (should return array or { y: array })", type: "calculated" },
            { name: "duration", display_name: "Display Duration (ms)", type: "number", default_value: 20000 },
            { name: "refreshRate", display_name: "Refresh Rate (ms)", type: "number", default_value: 1000 },
            { name: "yLabel", display_name: "Y Axis Label", type: "text", default_value: "Value" },
            { name: "yMin", display_name: "Y Min", type: "number" },
            { name: "yMax", display_name: "Y Max", type: "number" },
            { name: "showLegend", display_name: "Show Legend", type: "boolean", default_value: true }
        ],
        newInstance: function (settings, newInstanceCallback) {
            newInstanceCallback(new OwnTechPlotUPlot(settings));
        }
    });

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

    class OwnTechPlotUPlot {
        constructor(settings) {
            this.settings = settings;
            this.container = $('<div style="width:100%; height:100%; overflow:hidden;"></div>');
            this.plot = null;
            this.seriesCount = 0;
            this.dataBuffer = [[], []]; // [timestamps, [series1, series2, ...]]
            this.maxPoints = 2000;
            this.lastRender = 0;
            this.channelNames = [];
            this.channelColors = [];
            this.seriesMeta = [];
            this._parseSeriesMeta();
            this._updateMetaFromDatasource();
        }

        _parseSeriesMeta() {
            this.seriesMeta = [];
            const expr = String(this.settings.data || '');
            const regex = /datasources\[\s*['"]([^'"]+)['"]\]\s*\[\s*['"]y(\d+)['"]\s*\]/g;
            let m;
            while ((m = regex.exec(expr))) {
                this.seriesMeta.push({ ds: m[1], idx: parseInt(m[2], 10) });
            }
        }

        _updateMetaFromDatasource() {
            if (!this.seriesMeta.length) return;
            const cache = {};
            this.channelNames = [];
            this.channelColors = [];
            this.seriesMeta.forEach(meta => {
                if (!cache[meta.ds]) {
                    cache[meta.ds] = freeboard.getDatasourceSettings(meta.ds) || {};
                }
                const dsCfg = cache[meta.ds];
                const cfgs = dsCfg.channels;
                const paletteName = dsCfg.palette;
                const palette = COLOR_PALETTES[paletteName] || COLOR_PALETTES.default;
                const cfg = Array.isArray(cfgs) ? cfgs[meta.idx - 1] || {} : {};
                this.channelNames.push(cfg.name || `ch${meta.idx}`);
                const color = cfg.color && cfg.color.trim()
                    ? cfg.color
                    : palette[(meta.idx - 1) % palette.length];
                this.channelColors.push(color);
            });
        }

        render(containerElement) {
            this.container.appendTo(containerElement);
            this._initPlot();
        }

        _initPlot(series = null) {
            const resolvedSeries = series || [{ label: "Time" }];
            if (!series) {
                for (let i = 0; i < this.seriesCount; i++) {
                    const color = this.channelColors[i] || `hsl(${(i * 60) % 360}, 70%, 50%)`;
                    const label = this.channelNames[i] || `Channel ${i + 1}`;
                    resolvedSeries.push({ label, stroke: color });
                }
            }

            const opts = {
                title: this.settings.title || "",
                width: this.container.width(),
                height: this.container.height() || 300,
                legend: {
                    show: this.settings.showLegend !== false,
                },
                scales: {
                    x: { time: true },
                    y: {
                        auto: this.settings.yMin === undefined && this.settings.yMax === undefined,
                        range: [
                            this.settings.yMin !== undefined ? this.settings.yMin : null,
                            this.settings.yMax !== undefined ? this.settings.yMax : null,
                        ]
                    }
                },
                axes: [
                    {
                        stroke: "#666",
                        grid: { show: true },
                        values: (u, vals) => vals.map(v => new Date(v).toLocaleTimeString()),
                    },
                    {
                        stroke: "#666",
                        grid: { show: true },
                        label: this.settings.yLabel || "Value",
                    }
                ],
                series: resolvedSeries
            };

            this.plot = new uPlot(opts, this.dataBuffer, this.container[0]);
        }


        _updatePlotData(newDataArray) {
            const now = Date.now();

            // Ensure series count matches
            if (this.seriesCount !== newDataArray.length) {
                this.seriesCount = newDataArray.length;
                this._resetPlot();
                return;
            }

            // Push new values to dataBuffer
            this.dataBuffer[0].push(now);
            newDataArray.forEach((val, idx) => {
                this.dataBuffer[idx + 1].push(val);
            });

            // Trim to keep within time window
            const duration = this.settings.duration || 20000;
            const cutoff = now - duration;
            while (this.dataBuffer[0].length > 0 && this.dataBuffer[0][0] < cutoff) {
                this.dataBuffer[0].shift();
                for (let i = 1; i <= this.seriesCount; i++) {
                    this.dataBuffer[i].shift();
                }
            }

            // Update chart respecting refreshRate
            const refresh = parseInt(this.settings.refreshRate) || 1000;
            if (now - this.lastRender >= refresh) {
                this.plot.setData(this.dataBuffer);
                this.lastRender = now;
            }
        }

        _resetPlot() {
            if (this.plot) {
                this.plot.destroy();
                this.plot = null;
            }

            const series = [{ label: "Time" }];
            for (let i = 0; i < this.seriesCount; i++) {
                const color = this.channelColors[i] || `hsl(${(i * 60) % 360}, 70%, 50%)`;
                const label = this.channelNames[i] || `Channel ${i + 1}`;
                series.push({ label, stroke: color });
            }

            this.dataBuffer = [[], ...Array(this.seriesCount).fill().map(() => [])];
            this.lastRender = 0;
            this._initPlot(series);
        }

        
        onSettingsChanged(newSettings) {
            const needsReset = ['duration', 'yMin', 'yMax', 'yLabel', 'showLegend'].some(
                key => newSettings[key] !== this.settings[key]
            );
            const rateChanged = newSettings.refreshRate !== this.settings.refreshRate;
            const dataChanged = newSettings.data !== this.settings.data;

            this.settings = newSettings;

            if (dataChanged) {
                this._parseSeriesMeta();
                this._updateMetaFromDatasource();
            }

            if ((needsReset || dataChanged) && this.plot) {
                this._resetPlot();
            }
            if (rateChanged) {
                this.lastRender = 0;
            }
        }

        onCalculatedValueChanged(settingName, newValue) {
            if (!newValue) return;

            let yValues = [];
            if (typeof newValue === 'number') {
                yValues = [newValue];
            } else if (Array.isArray(newValue)) {
                yValues = newValue;
            } else if (newValue && Array.isArray(newValue.y)) {
                yValues = newValue.y;
            } else if (newValue && typeof newValue === 'object') {
                const keys = Object.keys(newValue)
                    .filter(k => /^y\d+$/.test(k))
                    .sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
                if (keys.length) {
                    yValues = keys.map(k => newValue[k]);
                }
            }
            let namesChanged = false;
            let colorsChanged = false;
            if (newValue && Array.isArray(newValue.channelNames)) {
                namesChanged = JSON.stringify(newValue.channelNames) !== JSON.stringify(this.channelNames);
                this.channelNames = newValue.channelNames;
            } else if (this.seriesMeta.length) {
                const before = JSON.stringify(this.channelNames);
                this._updateMetaFromDatasource();
                namesChanged = before !== JSON.stringify(this.channelNames);
            }
            if (newValue && Array.isArray(newValue.channelColors)) {
                colorsChanged = JSON.stringify(newValue.channelColors) !== JSON.stringify(this.channelColors);
                this.channelColors = newValue.channelColors;
            } else if (this.seriesMeta.length) {
                const before = JSON.stringify(this.channelColors);
                this._updateMetaFromDatasource();
                colorsChanged = before !== JSON.stringify(this.channelColors);
            }

            if (!yValues.length) {
                if ((namesChanged || colorsChanged) && this.plot) {
                    this._resetPlot();
                }
                return;
            }

            if (!this.plot || this.seriesCount !== yValues.length || namesChanged || colorsChanged) {
                this.seriesCount = yValues.length;
                this._resetPlot();
            }

            this._updatePlotData(yValues);
        }

        onDispose() {
            if (this.plot) {
                this.plot.destroy();
                this.plot = null;
            }
        }

        getHeight() {
            return 6;
        }
    }
})();
