(function () {
    // 🔍 Widget lookup
    function getWidgetByTitle(title) {
        return freeboardModel.panes()
            .flatMap(pane => pane.widgets())
            .find(widget => widget.settings().title === title);
    }

    // 🔍 Datasource lookup
    function getDatasourceByName(name) {
        return freeboardModel.datasources()
            .find(ds => ds.name() === name);
    }

    // 🔧 Global Dashboard Control API
    window.DashboardControl = {
        updateWidgetSetting(title, key, value) {
            const widget = getWidgetByTitle(title);
            if (widget && widget.settings()[key] !== undefined) {
                const newSettings = Object.assign({}, widget.settings());
                newSettings[key] = value;
                widget.settings(newSettings);
                // freeboard's subscription on settings will invoke onSettingsChanged
            }
        },

        updateDatasourceSetting(name, key, value) {
            const ds = getDatasourceByName(name);
            if (ds && ds.settings()[key] !== undefined) {
                const newSettings = Object.assign({}, ds.settings());
                newSettings[key] = value;
                ds.settings(newSettings);
                // datasource instance will be notified via Knockout
            }
        }
    };
})();