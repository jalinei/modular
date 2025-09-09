(function () {
    freeboard.loadWidgetPlugin({
        type_name: "owntech_plot_uplot",
        display_name: "Plot widget",
        description: "Realtime uPlot-based chart. Accepts streaming values or a full dataset",
        external_scripts: [
            "https://cdn.jsdelivr.net/npm/uplot@1.6.24/dist/uPlot.iife.min.js",
            "https://cdn.jsdelivr.net/npm/uplot@1.6.24/dist/uPlot.min.css"
        ],
        settings: [
            { name: "title", display_name: "Title", type: "text" },
            { name: "data", display_name: "Data (array, { y: array }, or { timestamps, series })", type: "calculated" },
            { name: "duration", display_name: "Display Duration (ms)", type: "number", default_value: 20000 },
            { name: "refreshRate", display_name: "Refresh Rate (ms)", type: "number", default_value: 1000 },
            { name: "yLabel", display_name: "Y Axis Label", type: "text", default_value: "Value" },
            // Use text inputs to make these optional without validation errors
            { name: "yMin", display_name: "Y Min (optional)", type: "text" },
            { name: "yMax", display_name: "Y Max (optional)", type: "text" },
            { name: "showLegend", display_name: "Show Legend", type: "boolean", default_value: true }
        ],
        newInstance: function (settings, newInstanceCallback) {
            newInstanceCallback(new OwnTechPlotUPlot(settings));
        }
    });

class OwnTechPlotUPlot {
        constructor(settings) {
            this.settings = settings;
            this.container = $('<div class="w-100 h-100 overflow-auto"></div>');
            this.plot = null;
            this.seriesCount = 0;
            this.dataBuffer = [[], []]; // [timestamps, [series1, series2, ...]]
            this.maxPoints = 2000;
            this.lastRender = 0;
            this._resizeObs = null;
            this._resizeRAF = 0;

            this.ipc = window.require?.('electron')?.ipcRenderer;
            this.headersByDs = {};
            this.colorsByDs = {};
            this.dsMap = [];
            this.datasourceName = '';
            this.channelIndices = [];
            this.lastHeaderCheck = 0;
            this._configHandler = () => this._maybeUpdateHeaders(true);
            freeboard.on && freeboard.on('config_updated', this._configHandler);
            this._detectDatasource();
        }

        _detectDatasource() {
            this.datasourceName = '';
            this.channelIndices = [];
            this.dsMap = [];
            if (typeof this.settings.data === 'string') {
                const pattern = /datasources\["([^"\]]+)"\]\["y(\d+)"\]/g;
                let m;
                while ((m = pattern.exec(this.settings.data)) !== null) {
                    const ds = m[1];
                    const idx = parseInt(m[2], 10) - 1;
                    this.dsMap.push({ ds, idx });
                }
                if (this.dsMap.length) {
                    this.datasourceName = this.dsMap[0].ds;
                    this.channelIndices = this.dsMap.map(d => d.idx);
                } else {
                    const dsMatch = this.settings.data.match(/datasources\[["']([^"']+)["']\]/);
                    if (dsMatch) this.datasourceName = dsMatch[1];
                    const chanRe = /\["y(\d+)"\]/g;
                    while ((m = chanRe.exec(this.settings.data)) !== null) {
                        const idx = parseInt(m[1], 10) - 1;
                        if (!isNaN(idx)) this.channelIndices.push(idx);
                    }
                }
            }
        }

        _getDatasourceType(name) {
            const live = freeboard.getLiveModel?.();
            if (!live || typeof live.datasources !== 'function') return null;
            const list = live.datasources();
            for (const ds of list) {
                try {
                    if (ds.name && ds.name() === name) {
                        return ds.type?.();
                    }
                } catch (e) { /* ignore */ }
            }
            return null;
        }

        async _fetchHeaders(dsName) {
            if (!this.ipc || !dsName) return [];
            const dsSettings = freeboard.getDatasourceSettings(dsName) || {};
            const path = dsSettings.portPath || dsName;
            const type = this._getDatasourceType(dsName);
            try {
                const headers = await this.ipc.invoke('get-serial-headers', { path, type });
                return Array.isArray(headers) ? headers : [];
            } catch (e) {
                console.error('header fetch failed', e);
                return [];
            }
        }

        async _fetchColors(dsName) {
            if (!this.ipc || !dsName) return [];
            const dsSettings = freeboard.getDatasourceSettings(dsName) || {};
            const path = dsSettings.portPath || dsName;
            const type = this._getDatasourceType(dsName);
            try {
                const colors = await this.ipc.invoke('get-serial-colors', { path, type });
                if (Array.isArray(colors) && colors.length) return colors;
            } catch (e) {
                console.error('color fetch failed', e);
            }
            if (Array.isArray(dsSettings.headers)) {
                return dsSettings.headers.map(h => h.color || null);
            }
            return [];
        }

        async _maybeUpdateHeaders(force = false) {
            const now = Date.now();
            if (!force && now - this.lastHeaderCheck < 1000) return;
            this.lastHeaderCheck = now;

            const uniqueDs = [...new Set([this.datasourceName, ...this.dsMap.map(d => d.ds)])].filter(Boolean);
            let changed = false;
            for (const ds of uniqueDs) {
                if (!ds) continue;
                const hdrs = await this._fetchHeaders(ds);
                const cols = await this._fetchColors(ds);
                if (!_.isEqual(hdrs, this.headersByDs[ds])) {
                    this.headersByDs[ds] = hdrs;
                    changed = true;
                }
                if (!_.isEqual(cols, this.colorsByDs[ds])) {
                    this.colorsByDs[ds] = cols;
                    changed = true;
                }
            }

            if (changed && this.plot) this._resetPlot();
        }

        _getSeriesLabel(idx) {
            const mapping = this.dsMap[idx] || {};
            const ds = mapping.ds ?? this.datasourceName;
            const chIdx = mapping.idx ?? this.channelIndices[idx] ?? idx;
            const headers = this.headersByDs[ds] || [];
            if (headers[chIdx]) return headers[chIdx];
            return `Channel ${chIdx + 1}`;
        }

        _getSeriesColor(idx) {
            const mapping = this.dsMap[idx] || {};
            const ds = mapping.ds ?? this.datasourceName;
            const chIdx = mapping.idx ?? this.channelIndices[idx] ?? idx;
            const colors = this.colorsByDs[ds] || [];
            if (colors[chIdx]) return colors[chIdx];
            return (typeof ColorBlind10 !== "undefined" ? ColorBlind10[idx % ColorBlind10.length] : `hsl(${(idx * 60) % 360}, 70%, 50%)`);
        }

        render(containerElement) {
            this.container.appendTo(containerElement);
            this._initPlot();
            this._maybeUpdateHeaders(true);
            this._bindResize();
        }

        _initPlot(series = null) {
            const resolvedSeries = series || [{ label: "Time" }];
            if (!series) {
                for (let i = 0; i < this.seriesCount; i++) {
                    const color = this._getSeriesColor(i);
                    const lbl = this._getSeriesLabel(i);
                    resolvedSeries.push({ label: lbl, stroke: color });
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
                    y: {}
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
            // Apply initial Y range (manual or computed)
            this._applyYAxisRange();
            // In case layout settles after init, try an async resize tick
            this._requestResize();
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
                // Update y-axis scaling if not fully manual
                this._applyYAxisRange();
                this.lastRender = now;
            }
        }

        _setFullDataset(dataset) {
            if (!dataset || !Array.isArray(dataset.timestamps) ||
                !Array.isArray(dataset.series)) {
                return;
            }

            this.seriesCount = dataset.series.length;

            if (!this.plot || this.plot.series.length - 1 !== this.seriesCount) {
                this._resetPlot();
            }

            this.dataBuffer = [dataset.timestamps, ...dataset.series];
            if (this.plot) {
                this.plot.setData(this.dataBuffer);
                this._applyYAxisRange();
                this.lastRender = Date.now();
            }
        }

        _resetPlot() {
            if (this.plot) {
                this.plot.destroy();
                this.plot = null;
            }

            const series = [{ label: "Time" }];
            for (let i = 0; i < this.seriesCount; i++) {
                const color = this._getSeriesColor(i);
                const lbl = this._getSeriesLabel(i);
                series.push({ label: lbl, stroke: color });
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
            const titleChanged = newSettings.title !== this.settings.title;

            this.settings = newSettings;
            this._detectDatasource();
            this._maybeUpdateHeaders(true);

            if (needsReset && this.plot) {
                this._resetPlot();
            }
            // If only refresh/title changed, still re-apply y range in case bounds changed
            if (!needsReset && this.plot) {
                this._applyYAxisRange();
            }
            if (titleChanged && this.plot) {
                const tEl = this.plot.root.querySelector('.u-title');
                if (tEl) tEl.textContent = this.settings.title || '';
            }
            if (rateChanged) {
                this.lastRender = 0;
            }
        }

        onCalculatedValueChanged(settingName, newValue) {
            this._maybeUpdateHeaders();
            if (!newValue) return;

            if (newValue && Array.isArray(newValue.timestamps) && Array.isArray(newValue.series)) {
                this._setFullDataset(newValue);
                return;
            }

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
            if (this._resizeObs) {
                try { this._resizeObs.disconnect(); } catch {}
                this._resizeObs = null;
            }
            if (this._resizeRAF) {
                cancelAnimationFrame(this._resizeRAF);
                this._resizeRAF = 0;
            }
            // Remove fallback window resize handler if used
            try { $(window).off('resize.uplot-widget'); } catch {}
            if (this._configHandler && freeboard.off) {
                freeboard.off('config_updated', this._configHandler);
            }
        }

        getHeight() {
            return 6;
        }

        // Compute smart defaults and/or apply manual Y range
        _applyYAxisRange() {
            if (!this.plot) return;

            const yMin = this._parseMaybeNumber(this.settings.yMin);
            const yMax = this._parseMaybeNumber(this.settings.yMax);
            const hasMin = yMin != null;
            const hasMax = yMax != null;

            // Compute current data range across all series
            const [dataMin, dataMax] = this._computeDataYRange();

            let min = dataMin;
            let max = dataMax;

            if (hasMin && hasMax) {
                min = yMin;
                max = yMax;
            } else if (hasMin && !hasMax) {
                min = yMin;
                if (isFinite(dataMax)) {
                    max = Math.max(dataMax, min + this._niceDelta(Math.abs(dataMax - min)));
                } else {
                    max = min + 1; // fallback span
                }
            } else if (!hasMin && hasMax) {
                max = yMax;
                if (isFinite(dataMin)) {
                    min = Math.min(dataMin, max - this._niceDelta(Math.abs(max - dataMin)));
                } else {
                    min = max - 1; // fallback span
                }
            } else {
                // No manual bounds: apply smart padding and nice rounding
                const padded = this._paddedNiceRange(dataMin, dataMax);
                min = padded[0];
                max = padded[1];
            }

            if (!isFinite(min) || !isFinite(max) || min === max) {
                // Safe default if no data or degenerate
                const mid = isFinite(min) ? min : (isFinite(max) ? max : 0);
                min = mid - 0.5;
                max = mid + 0.5;
            }

            try {
                this.plot.setScale('y', { min, max });
            } catch (e) {
                // ignore scaling errors
            }
        }

        _parseMaybeNumber(val) {
            if (val === undefined || val === null) return null;
            if (typeof val === 'number') return isFinite(val) ? val : null;
            if (typeof val === 'string') {
                const trimmed = val.trim();
                if (trimmed === '') return null;
                const n = parseFloat(trimmed);
                return isFinite(n) ? n : null;
            }
            return null;
        }

        _computeDataYRange() {
            let min = Infinity;
            let max = -Infinity;

            for (let s = 1; s < this.dataBuffer.length; s++) {
                const arr = this.dataBuffer[s] || [];
                for (let i = 0; i < arr.length; i++) {
                    const v = arr[i];
                    if (v == null) continue;
                    if (!isFinite(v)) continue;
                    if (v < min) min = v;
                    if (v > max) max = v;
                }
            }

            if (min === Infinity || max === -Infinity) return [NaN, NaN];
            return [min, max];
        }

        _paddedNiceRange(min, max) {
            if (!isFinite(min) || !isFinite(max)) return [0, 1];
            if (min === max) {
                const span = Math.max(1e-6, Math.abs(min) * 0.1);
                return [min - span, max + span];
            }
            const span = max - min;
            const pad = span * 0.1; // 10% padding
            const rawMin = min - pad;
            const rawMax = max + pad;
            return this._niceBounds(rawMin, rawMax);
        }

        _niceBounds(min, max) {
            // Round bounds to "nice" numbers to avoid awkward decimals
            const span = max - min;
            if (!isFinite(span) || span <= 0) return [min, max];
            const step = this._niceDelta(span / 8); // target ~8 ticks
            const niceMin = Math.floor(min / step) * step;
            const niceMax = Math.ceil(max / step) * step;
            return [niceMin, niceMax];
        }

        _niceDelta(raw) {
            if (!isFinite(raw) || raw <= 0) return 1;
            const exp = Math.floor(Math.log10(raw));
            const frac = raw / Math.pow(10, exp);
            let niceFrac;
            if (frac <= 1) niceFrac = 1;
            else if (frac <= 2) niceFrac = 2;
            else if (frac <= 2.5) niceFrac = 2.5;
            else if (frac <= 5) niceFrac = 5;
            else niceFrac = 10;
            return niceFrac * Math.pow(10, exp);
        }

        _bindResize() {
            if (this._resizeObs || !this.container || !this.container[0]) return;
            const el = this.container[0];
            if (typeof ResizeObserver !== 'undefined') {
                this._resizeObs = new ResizeObserver(() => this._requestResize());
                this._resizeObs.observe(el);
            } else {
                // Fallback: resize on window events
                $(window).on('resize.uplot-widget', () => this._requestResize());
            }
        }

        _requestResize() {
            if (!this.plot || !this.container) return;
            if (this._resizeRAF) cancelAnimationFrame(this._resizeRAF);
            this._resizeRAF = requestAnimationFrame(() => {
                this._resizeRAF = 0;
                const w = Math.max(0, this.container.width());
                let h = Math.max(0, this.container.height());
                // Subtract non-plot vertical elements (title + legend) to avoid overflow
                try {
                    const root = this.plot.root;
                    const titleEl = root.querySelector('.u-title');
                    const legendEl = root.querySelector('.u-legend');
                    const titleH = titleEl && getComputedStyle(titleEl).display !== 'none' ? titleEl.offsetHeight : 0;
                    const legendH = legendEl && getComputedStyle(legendEl).display !== 'none' ? legendEl.offsetHeight : 0;
                    const extra = titleH + legendH;
                    if (extra > 0) h = Math.max(0, h - extra);
                } catch {}

                if (w && h) {
                    try { this.plot.setSize({ width: w, height: h }); } catch {}
                }
            });
        }
    }
})();
