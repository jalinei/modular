(function () {
    freeboard.loadWidgetPlugin({
        type_name: "owntech_plot",
        display_name: "OwnTech Plot",
        description: "Realtime Chart.js Plot for OwnTech",
        external_scripts: [
            "plugins/thirdparty/luxon.min.js",
            "plugins/thirdparty/chart.umd.js",
            "plugins/thirdparty/chartjs-plugin-streaming.min.js",
            "plugins/thirdparty/chartjs-adapter-luxon.umd.js"
        ],
        settings: [
            {
                name: "title",
                display_name: "Title",
                type: "text"
            },
            {
                name: "data",
                display_name: "Data (should return array or { y: array })",
                type: "calculated",
                multi_input: false
            },
            {
                name: "duration",
                display_name: "Display Duration (ms)",
                type: "number",
                default_value: 20000
            },
            {
                name: "refreshRate",
                display_name: "Refresh Rate (ms)",
                type: "number",
                default_value: 1000
            },
            {
                name: "yLabel",
                display_name: "Y Axis Label",
                type: "text",
                default_value: "Value"
            },
            {
                name: "yMin",
                display_name: "Y Min",
                type: "number"
            },
            {
                name: "yMax",
                display_name: "Y Max",
                type: "number"
            },
            {
                name: "showLegend",
                display_name: "Show Legend",
                type: "boolean",
                default_value: true
            },
            {
                name: "legendPosition",
                display_name: "Legend Position",
                type: "option",
                options: [
                    { name: "Top", value: "top" },
                    { name: "Bottom", value: "bottom" },
                    { name: "Left", value: "left" },
                    { name: "Right", value: "right" }
                ],
                default_value: "right"
            }
        ],
        newInstance: function (settings, newInstanceCallback) {
            newInstanceCallback(new OwnTechPlot(settings));
        }
    });

    const lineStylesEnum = {
        full: [],
        short: [1, 1],
        medium: [10, 10],
        long: [20, 5],
        alternate: [15, 3, 3, 3]
    };

    const pointStylesEnum = {
        circle: 'circle',
        cross: 'cross',
        triangle: 'triangle',
        square: 'rect'
    };

    class OwnTechPlot {
        constructor(settings) {
            this.settings = settings;
            this.chart = null;
            this.container = $("<div class='owntech-plot' style='height:100%; width:100%; overflow-y: auto;'></div>");
        }

        render(containerElement) {
            this.container.appendTo(containerElement);

            const canvas = $("<canvas></canvas>").css({ height: "300px", width: "100%" }).appendTo(this.container)[0];
            const ctx = canvas.getContext('2d');

            // Chart.js setup
            this.chart = new Chart(ctx, {
                type: 'line',
                data: { datasets: [] },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: {
                            type: 'realtime',
                            realtime: {
                                duration: this.settings.duration || 20000,
                                refresh: this.settings.refreshRate || 1000,
                                delay: 500,
                                pause: false,
                                onRefresh: () => {}
                            }
                        },
                        y: {
                            beginAtZero: true,
                            min: this.settings.yMin !== undefined ? this.settings.yMin : undefined,
                            max: this.settings.yMax !== undefined ? this.settings.yMax : undefined,
                            title: {
                                display: true,
                                text: this.settings.yLabel || "Value"
                            }
                        }
                    },
                    plugins: {
                        legend: {
                            display: this.settings.showLegend !== false,
                            position: this.settings.legendPosition || "right"
                        },
                        title: {
                            display: !!this.settings.title,
                            text: this.settings.title || ''
                        }
                    }
                }
            });

            // Add configuration table below chart
            const configHTML = `
                <div class="chart-config-panel" style="margin-top: 10px;">
                    <table style="width: 100%; font-size: 12px;" border="1" cellspacing="0" cellpadding="4">
                        <thead>
                            <tr>
                                <th>Channel</th>
                                <th>Label</th>
                                <th>Color</th>
                                <th>Axis</th>
                                <th>Visible</th>
                                <th>Style</th>
                            </tr>
                        </thead>
                        <tbody id="chart-config-body"></tbody>
                    </table>
                </div>
            `;
            this.container.append(configHTML);
        }

        updateLegendConfigUI() {
            const tbody = this.container.find("#chart-config-body");
            if (!tbody.length || !this.chart) return;

            tbody.empty();

            this.chart.data.datasets.forEach((ds, i) => {
                const row = $(`
                    <tr>
                        <td>Channel ${i + 1}</td>
                        <td><input type="text" class="label-input" data-index="${i}" value="${ds.label}"/></td>
                        <td><input type="color" class="color-input" data-index="${i}" value="${ds.borderColor}"/></td>
                        <td>
                            <select class="axis-select" data-index="${i}">
                                <option value="y" ${ds.yAxisID === "y" ? "selected" : ""}>Y</option>
                                <option value="y2" ${ds.yAxisID === "y2" ? "selected" : ""}>Y2</option>
                            </select>
                        </td>
                        <td><input type="checkbox" class="visible-check" data-index="${i}" ${ds.hidden ? "" : "checked"} /></td>
                        <td>
                            <select class="style-select" data-index="${i}">
                                ${Object.keys(lineStylesEnum).map(style =>
                                    `<option value="${style}" ${JSON.stringify(ds.borderDash) === JSON.stringify(lineStylesEnum[style]) ? "selected" : ""}>${style}</option>`
                                ).join("")}
                            </select>
                        </td>
                    </tr>
                `);
                tbody.append(row);
            });

            this._bindConfigEvents();
        }

        _bindConfigEvents() {
            const chart = this.chart;

            this.container.find(".label-input").on("input", function () {
                const i = this.dataset.index;
                chart.data.datasets[i].label = this.value;
                chart.update();
            });

            this.container.find(".color-input").on("input", function () {
                const i = this.dataset.index;
                chart.data.datasets[i].borderColor = this.value;
                chart.data.datasets[i].backgroundColor = this.value + "33";
                chart.update();
            });

            this.container.find(".axis-select").on("change", function () {
                const i = this.dataset.index;
                chart.data.datasets[i].yAxisID = this.value;
                chart.update();
            });

            this.container.find(".visible-check").on("change", function () {
                const i = this.dataset.index;
                chart.data.datasets[i].hidden = !this.checked;
                chart.update();
            });

            this.container.find(".style-select").on("change", function () {
                const i = this.dataset.index;
                const style = this.value;
                chart.data.datasets[i].borderDash = lineStylesEnum[style];
                chart.update();
            });
        }

        _resizePlot() {
            if (this.plot && this.container.is(":visible")) {
                this.plot.setSize({
                    width: this.container.width(),
                    height: this.container.height()
                });
            }
        }

        getHeight() {
            return 6; // You can customize this based on preference
        }

        onSettingsChanged(newSettings) {
            this.settings = newSettings;
            if (this.chart && this.chart.options.plugins.title) {
                this.chart.options.plugins.title.text = newSettings.title || '';
                this.chart.options.plugins.title.display = !!newSettings.title;
                this.chart.options.scales.x.realtime.refresh = this.settings.refreshRate || 1000;
                this.chart.options.plugins.legend.display = newSettings.showLegend !== false;
                this.chart.options.plugins.legend.position = newSettings.legendPosition || 'right';
                
                this.chart.options.scales.y.title.text = newSettings.yLabel || 'Value';
                this.chart.options.scales.y.min = newSettings.yMin !== undefined ? newSettings.yMin : undefined;
                this.chart.options.scales.y.max = newSettings.yMax !== undefined ? newSettings.yMax : undefined;
                
                this.chart.update('none');
            }
        }

        onCalculatedValueChanged(settingName, newValue) {
            if (!this.chart) {
                // Chart not ready yet — retry shortly
                setTimeout(() => this.onCalculatedValueChanged(settingName, newValue), 500);
                return;
            }
        
            // Normalize input
            if (newValue && typeof newValue === 'object' && Array.isArray(newValue.y)) {
                newValue = newValue.y;
            } else if (typeof newValue === 'number') {
                newValue = [newValue];
            }
        
            if (!Array.isArray(newValue)) return;
        
            const timestamp = Date.now();
        
            // Ensure datasets exist
            while (this.chart.data.datasets.length < newValue.length) {
                const index = this.chart.data.datasets.length;
                this.chart.data.datasets.push({
                    label: `Channel ${index + 1}`,
                    borderColor: `hsl(${(index * 60) % 360}, 70%, 50%)`,
                    backgroundColor: `hsla(${(index * 60) % 360}, 70%, 50%, 0.1)`,
                    fill: false,
                    data: [],
                    borderDash: [],
                    pointStyle: 'circle',
                    pointRadius: 2
                });
            }
        
            // Append new data
            newValue.forEach((val, idx) => {
                if (this.chart.data.datasets[idx]) {
                    this.chart.data.datasets[idx].data.push({ x: timestamp, y: val });
                }
            });

        if (newValue.length !== this.chart.data.datasets.length) {
            this.updateLegendConfigUI();
        }
            this.chart.update('quiet');
        }

        onDispose() {
            if (this.chart) {
                this.chart.destroy();
            }
        }
    }
})();