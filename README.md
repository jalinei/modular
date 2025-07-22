# Modular

Modular is an Electron application built on top of [Freeboard](dashboard/README.md) for monitoring data coming from serial devices. It provides custom Freeboard plugins for reading serial ports, displaying terminal output, recording CSV files and flashing firmware to boards using **mcumgr**.

## Features

- **Serial datasources** – read numeric values from any serial port using a configurable separator and end of line.
- **Real time dashboards** – create dashboards using Freeboard widgets or the provided custom widgets (uPlot charts, serial terminal, etc.).
- **CSV recording** – record incoming data to a CSV file with optional timestamps.
- **Firmware flashing** – flash boards that support mcumgr directly from the GUI.

## Getting started

1. Install [Node.js](https://nodejs.org/) 20 or later.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Launch the application in development mode:
   ```bash
   npm start
   ```
   The dashboard will be loaded from the `dashboard` directory.
4. To build distributable packages use:
   ```bash
   npm run dist
   ```
   Binaries for the current platform will be placed in the `dist` folder.

Sample dashboard configurations can be found under [`test_dashboards`](test_dashboards/).

## Repository layout

- `main.js` – Electron main process that handles serial ports and IPC.
- `flasher.js` – helper used for firmware flashing through mcumgr.
- `dashboard/` – bundled Freeboard source with additional plugins.
- `test_dashboards/` – example dashboards for development or testing.

## License

The code in this repository is provided under the MIT License. See [`dashboard/LICENSE`](dashboard/LICENSE) for details about the Freeboard components bundled with this application.
