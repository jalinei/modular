(function () {
    freeboard.loadWidgetPlugin({
        type_name: "uplot_config_panel",
        display_name: "uPlot Config Panel",
        description: "Control panel to adjust settings of uPlot widgets",
        settings: [],
        newInstance: function (settings, newInstanceCallback) {
            newInstanceCallback(new UPlotConfigPanel(settings));
        }
    });

    class UPlotConfigPanel {
        constructor(settings) {
            this.settings = settings;
            this.container = $('<div style="height:100%; overflow-y:auto; padding:8px; box-sizing:border-box;"></div>');            
            this.controls = {};
        }

        render(containerElement) {
            this.container.empty();
            this.controls = {};

            const form = $('<div></div>');

            const titleRow = $('<div style="margin-bottom:8px;"></div>');
            const titleLabel = $('<label style="display:block;">Select Target Widget</label>');
            const titleSelect = $('<select style="width:100%; box-sizing:border-box;"></select>');
            this.controls.target_widget_title = titleSelect;

            // Load settings only when user selects a widget manually
            titleSelect.on("change", () => {
                if (titleSelect.val()) {
                    this.syncFromSelectedWidget();
                }
            });

            titleRow.append(titleLabel).append(titleSelect);
            form.append(titleRow);

            const createInput = (labelText, key, type = 'text') => {
                const wrapper = $('<div style="margin-bottom:8px; display:flex; justify-content: flex-end;"></div>');
                const label = $(`<label style="flex:1">${labelText}</label>`);
                const input = $(`<input type="${type}" style="width:70%; box-sizing:border-box;">`); 
                this.controls[key] = input;
                wrapper.append(label).append(input);
                return wrapper;
            };

            form.append(createInput("Display Duration (ms)", "duration", "number"));
            form.append(createInput("Refresh Rate (ms)", "refreshRate", "number"));
            form.append(createInput("Y Axis Label", "yLabel"));
            form.append(createInput("Y Min", "yMin", "number"));
            form.append(createInput("Y Max", "yMax", "number"));

            const legendWrapper = $('<div style="margin-bottom:8px;"></div>');
            const legendLabel = $('<label>Show Legend</label>');
            const legendCheckbox = $('<input type="checkbox">');
            this.controls.showLegend = legendCheckbox;
            legendWrapper.append(legendLabel).append(legendCheckbox);
            form.append(legendWrapper);

            const btn = $('<button style="width:100%; box-sizing:border-box;">Apply Settings</button>');           
            btn.on('click', () => this.applySettings());

            this.container.append(form).append(btn);
            $(containerElement).append(this.container);

            // Watch for future changes
            freeboard.on("initialized", () => this.populateWidgetDropdown());
            freeboard.on("config_updated", () => this.populateWidgetDropdown());

            // Call immediately for current widgets
            this.populateWidgetDropdown();
        }

        syncFromSelectedWidget() {
            const model = freeboard.getLiveModel();
            const title = this.controls.target_widget_title.val();

            const widget = model
                .panes()
                .flatMap(p => p.widgets())
                .find(w => {
                    let wTitle = w.settings().title;
                    if (typeof wTitle === "function") wTitle = wTitle();
                    return wTitle === title && w.type() === "owntech_plot_uplot";
                });

            if (!widget) return;

            const settings = widget.settings();

            this.controls.duration.val(typeof settings.duration === "function" ? settings.duration() : settings.duration || 20000);
            this.controls.refreshRate.val(typeof settings.refreshRate === "function" ? settings.refreshRate() : settings.refreshRate || 1000);
            this.controls.yLabel.val(typeof settings.yLabel === "function" ? settings.yLabel() : settings.yLabel || "");
            this.controls.yMin.val(typeof settings.yMin === "function" ? settings.yMin() : settings.yMin || "");
            this.controls.yMax.val(typeof settings.yMax === "function" ? settings.yMax() : settings.yMax || "");
            this.controls.showLegend.prop("checked", !!(
                typeof settings.showLegend === "function" ? settings.showLegend() : settings.showLegend
            ));
        }
        populateWidgetDropdown() {
            const titleSelect = this.controls.target_widget_title;
            const widgets = [];
            const model = freeboard.getLiveModel(); 
            const panes = model.panes();

            panes.forEach(pane => {
                pane.widgets().forEach(widget => {
                    if (widget.type() === "owntech_plot_uplot") {
                        const title = typeof widget.settings().title === "function"
                            ? widget.settings().title()
                            : widget.settings().title;

                        if (title) {
                            widgets.push(title);
                        }
                    }
                });
            });

        const selected = titleSelect.val();
        titleSelect.empty();

        widgets.forEach(title => {
            titleSelect.append($('<option>').val(title).text(title));
        });

        if (selected && titleSelect.find(`option[value="${selected}"]`).length) {
            titleSelect.val(selected);
        }
    }


        applySettings() {
            const model = freeboard.getLiveModel();
            const title = this.controls.target_widget_title.val();

            const widget = model
                .panes()
                .flatMap(p => p.widgets())
                .find(w => {
                    let wTitle = w.settings().title;
                    if (typeof wTitle === "function") wTitle = wTitle();
                    return wTitle === title && w.type() === "owntech_plot_uplot";
                });

            if (!widget) {
                console.warn("uPlot widget not found:", title);
                return;
            }


            const yMinVal = parseFloat(this.controls.yMin.val());
            const yMaxVal = parseFloat(this.controls.yMax.val());

            const updatedSettings = {
                ...widget.settings(),
                duration: parseInt(this.controls.duration.val()) || 20000,
                refreshRate: parseInt(this.controls.refreshRate.val()) || 1000,
                yLabel: this.controls.yLabel.val() || "Value",
                yMin: isNaN(yMinVal) ? undefined : yMinVal,
                yMax: isNaN(yMaxVal) ? undefined : yMaxVal,
                showLegend: this.controls.showLegend.prop("checked")
            };

            widget.settings(updatedSettings);
            widget.widgetInstance.onSettingsChanged(updatedSettings);
        }

        onSettingsChanged(newSettings) {
            this.settings = newSettings;
        }

        getHeight() {
            return 5;
        }

        onDispose() {}
    }
})();