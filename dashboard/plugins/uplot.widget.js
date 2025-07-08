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

    class OwnTechPlotUPlot {
        constructor(settings) {
            this.settings = settings;
            this.container = $('<div style="width:100%; height:100%; overflow:hidden;"></div>');
            this.plot = null;
            this.seriesCount = 0;
            this.dataBuffer = [[], []]; // [timestamps, [series1, series2, ...]]
            this.maxPoints = 2000;
            this.lastRender = 0;
        }

        render(containerElement) {
            this.container.appendTo(containerElement);
            this._initPlot();
        }

        _initPlot(series = null) {
            const resolvedSeries = series || [{ label: "Time" }];
            if (!series) {
                for (let i = 0; i < this.seriesCount; i++) {
                    const color = `hsl(${(i * 60) % 360}, 70%, 50%)`;
                    resolvedSeries.push({ label: `Channel ${i + 1}`, stroke: color });
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
                const color = `hsl(${(i * 60) % 360}, 70%, 50%)`;
                series.push({ label: `Channel ${i + 1}`, stroke: color });
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

            this.settings = newSettings;

            if (needsReset && this.plot) {
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
            }

            if (!yValues.length) return;

            if (!this.plot) {
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
