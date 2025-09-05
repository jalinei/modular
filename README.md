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

## ThingSet over CAN

JavaScript implementation of the CAN/ThingSet protocol under `js/`:

- `js/ts_can_utils.js` – CAN ID builder and ISO‑TP response reassembly.
- `js/thingset_bin.js` – ISO‑TP TX/RX and high‑level ThingSet client (`ThingSetCAN`).
- `js/scan.js` – scans the bus for nodes by requesting `pNodeID`. Outputs a json file containing both used addressed on the bus and node IDs
- `js/query_nodes.js` – recursively explores a node’s ThingSet tree and writes a JSON per device containing all its datanodes structure.
- `js/can_adapter.js` – CAN bus wrapper: native SocketCAN on Linux; on Windows use `ffi-napi` to call a vendor driver (no built‑in CAN).

Dependencies

- Included in `package.json`: `socketcan` (Linux) and `cbor`.
- Windows (optional): `ffi-napi` (+ `ref-napi`, vendor DLL) to bind a driver API.

Install

```bash
npm install
```

Test commands

- Scan the bus: `npm run scan:can`
- Build node trees: `npm run ts:query`
- Basic client test: `npm run ts:test`

Windows support: use `ffi-napi` to bind your CAN vendor’s driver (e.g., Kvaser, PEAK PCAN, NI‑CAN) and implement the same `Bus` interface in `js/can_adapter.js` (`send`, `recv(timeoutMs)`, `shutdown`). No SocketCAN is required on Windows.

## Repository layout

- `main.js` – Electron main process that handles serial ports and IPC.
- `flasher.js` – helper used for firmware flashing through mcumgr.
- `dashboard/` – bundled Freeboard source with additional plugins.
- `test_dashboards/` – example dashboards for development or testing.

## License

The code in this repository is provided under the MIT License. See [`dashboard/LICENSE`](dashboard/LICENSE) for details about the Freeboard components bundled with this application.
