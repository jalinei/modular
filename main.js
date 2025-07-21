const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { SerialPort } = require('serialport');
const fs = require('fs');
const { flashFirmware, cancelFlash } = require('./flasher');

let mainWindow; // reference to the main BrowserWindow

// Path to mcumgr binary, assumes it is bundled alongside the app in a tools folder
const mcumgrBinary = process.platform === 'win32' ? 'mcumgr.exe'
    : process.platform === 'darwin' ? 'mcumgr-mac' : 'mcumgr';
const mcumgrPath = path.join(__dirname, 'tools', mcumgrBinary);

const activeRecordings = new Map(); // Active CSV recordings mapped by port path
const openPorts = new Map(); // key: path, value: SerialPort instance
const terminalBuffers = new Map(); // key: path, value: array of raw lines
const serialBuffers = new Map(); // key: path, value: array of parsed data arrays
const headerBuffers = new Map(); // key: path, value: array of header labels
const colorBuffers = new Map(); // key: path, value: array of color strings
const fastStates = new Map(); // key: path, value: state for fast frame parsing
const fastBuffers = new Map(); // key: path, value: last parsed fast dataset
const FAST_IDLE = 0;
const FAST_RECORD = 1;
const MAX_BUFFER_SIZE = 1000;
const MAX_TERMINAL_LINES = 200;



let currentSettings = {
	separator: ":",
	eol: "\n"
};

function addToBuffer(portPath, parsedData) {
        if (!Array.isArray(parsedData)) return;
        let buf = serialBuffers.get(portPath);
        if (!buf) {
                buf = [];
                serialBuffers.set(portPath, buf);
        }
        buf.push(parsedData);
        if (buf.length > MAX_BUFFER_SIZE) {
                buf.shift();
        }
}

function parseLine(line) {
	const clean = line.trim();
	const rawItems = clean.split(currentSettings.separator).filter(s => s.trim() !== "");
	const values = rawItems.map(v => parseFloat(v)).filter(n => !isNaN(n));
	return values;
}

function parseLineCustom(line, sep) {
        const clean = line.trim();
        return clean.split(sep).map(s => s.trim()).filter(s => s !== "");
}

function handleFastLine(portPath, line) {
    let st = fastStates.get(portPath);
    if (!st) {
        st = { state: FAST_IDLE, header: null, idx: null, data: [] };
        fastStates.set(portPath, st);
    }

    if (line.includes('begin record')) {
        st.state = FAST_RECORD;
        st.header = null;
        st.idx = null;
        st.data = [];
        return;
    }

    if (line.includes('end record')) {
        st.state = FAST_IDLE;
        const dataset = buildFastDataset(st);
        if (dataset) fastBuffers.set(portPath, dataset);
        st.header = null;
        st.idx = null;
        st.data = [];
        return;
    }

    if (st.state === FAST_RECORD) {
        if (line.startsWith('#')) {
            if (!st.header) {
                st.header = line.substring(1).trim();
                const hdrs = st.header.split(',').map(h => h.trim()).filter(Boolean);
                headerBuffers.set(portPath, hdrs);
            } else if (st.idx === null) {
                const num = parseInt(line.substring(1).trim());
                st.idx = isNaN(num) ? null : num;
            }
        } else if (line.trim()) {
            st.data.push(line.trim());
        }
    }
}

function buildFastDataset(st) {
    if (!st.header || !st.data.length) return null;
    let names = st.header.split(',').map(n => n.trim());
    if (names[names.length - 1] === '') names.pop();

    const floats = [];
    for (const hex of st.data) {
        try {
            const buf = Buffer.from(hex, 'hex');
            if (buf.length >= 4) floats.push(buf.readFloatBE(0));
        } catch { /* ignore */ }
    }

    const chunk = names.length;
    const rows = [];
    for (let i = 0; i < floats.length; i += chunk) {
        rows.push(floats.slice(i, i + chunk));
    }
    if (!rows.length) return null;

    if (st.idx !== null && st.idx >= 0 && st.idx < rows.length) {
        const shift = (st.idx + 1) % rows.length;
        if (shift) {
            for (let i = 0; i < shift; i++) {
                rows.push(rows.shift());
            }
        }
    }

    const timestamps = rows.map((_, i) => i);
    const series = names.map((_, ci) => rows.map(r => r[ci]));

    return { timestamps, series };
}

function createWindow() {
        mainWindow = new BrowserWindow({
                width: 1280,
                height: 800,
                webPreferences: {
                        nodeIntegration: true,
                        contextIsolation: false
                }
        });
        mainWindow.loadFile(path.join(__dirname, 'dashboard/index.html'));
        mainWindow.on('closed', () => {
                mainWindow = null;
        });
}

app.whenReady().then(createWindow);

// 🔌 List serial ports
ipcMain.handle('get-serial-ports', async () => {
	const ports = await SerialPort.list();
	return ports.map(port => ({
		name: port.path,
		value: port.path
	}));
});

// 🚪 Open serial port with tracking and buffer setup
ipcMain.handle("open-serial-port", async (event, { path, baudRate, separator, eol }) => {
	if (openPorts.has(path)) {
		console.warn(`Port ${path} is already open.`);
		return;
	}

	currentSettings.separator = separator || ":";
  currentSettings.eol = eol ? JSON.parse(`"${eol}"`) : "\n";

	const port = new SerialPort({
		path,
		baudRate: parseInt(baudRate),
		autoOpen: false
	});

	port.open(err => {
			if (err) {
					console.error("Serial open error:", err.message);
					return;
			}
			console.log("✅ Serial port opened:", path);
	});

	let rawBuffer = "";

        terminalBuffers.set(path, []);
        serialBuffers.set(path, []);
        headerBuffers.set(path, []);
        colorBuffers.set(path, []);
        fastStates.set(path, { state: FAST_IDLE, header: null, idx: null, data: [] });
        fastBuffers.delete(path);

        port.on("data", chunk => {
                        rawBuffer += chunk.toString();
                        const lines = rawBuffer.split(currentSettings.eol);
                        rawBuffer = lines.pop(); // keep the last (possibly incomplete) line
                        const termBuf = terminalBuffers.get(path) || [];
                        for (const line of lines) {
                                        const parsed = parseLine(line);
                                        if (parsed.length) addToBuffer(path, parsed);
                                        handleFastLine(path, line);
                                        termBuf.push(line);
                                        if (termBuf.length > MAX_TERMINAL_LINES) termBuf.shift();
                        }
                        terminalBuffers.set(path, termBuf);
        });

	port.on("error", err => {
		console.error("Serial port error:", err.message);
	});

        port.on("close", () => {
                        console.log(`🔌 Serial port ${path} closed.`);
                        openPorts.delete(path);
                        terminalBuffers.delete(path);
                        serialBuffers.delete(path);
                        headerBuffers.delete(path);
                        colorBuffers.delete(path);
                        fastStates.delete(path);
                        fastBuffers.delete(path);
        });

	openPorts.set(path, port);
});

// 📥 Renderer pulls latest parsed data
ipcMain.handle("get-serial-buffer", (event, { path }) => {
        const buf = serialBuffers.get(path) || [];
        return buf.length > 0 ? buf[buf.length - 1] : [];
});

ipcMain.handle('get-fast-dataset', (event, { path }) => {
    return fastBuffers.get(path) || null;
});

// 📄 Get terminal lines for a port
ipcMain.handle("get-terminal-buffer", (event, { path }) => {
        return terminalBuffers.get(path) || [];
});

// 🏷️ Get/set headers for a port
ipcMain.handle('get-serial-headers', (_event, { path }) => {
    return headerBuffers.get(path) || [];
});

ipcMain.handle('set-serial-headers', (_event, { path, headers }) => {
    if (!Array.isArray(headers)) headers = [];
    headerBuffers.set(path, headers);
    return 'ok';
});

// 🎨 Get/set colors for a port
ipcMain.handle('get-serial-colors', (_event, { path }) => {
    return colorBuffers.get(path) || [];
});

ipcMain.handle('set-serial-colors', (_event, { path, colors }) => {
    if (!Array.isArray(colors)) colors = [];
    colorBuffers.set(path, colors);
    return 'ok';
});

// ❌ Close port
ipcMain.handle("close-serial-port", async (event, { path }) => {
	const port = openPorts.get(path);
	if (port && port.isOpen) {
			return new Promise((resolve, reject) => {
					port.close(err => {
							if (err) return reject(err.message);
                                                        openPorts.delete(path);
                                                        terminalBuffers.delete(path);
                                                        serialBuffers.delete(path);
                                                        headerBuffers.delete(path);
                                                        colorBuffers.delete(path);
                                                        fastStates.delete(path);
                                                        fastBuffers.delete(path);
                                                        resolve("closed");
                                        });
                        });
	} else {
			return "not open";
	}
});

// ➡️ Write data to an open serial port
ipcMain.handle("write-serial-port", async (event, { path, data }) => {
        // Pick specified port or default to the first one
        const targetPort = path ? openPorts.get(path) : openPorts.values().next().value;
        if (targetPort && targetPort.isOpen) {
                return new Promise((resolve, reject) => {
                        targetPort.write(data, err => {
                                if (err) return reject(err.message);
                                targetPort.drain(drainErr => {
                                        if (drainErr) return reject(drainErr.message);
                                        resolve("written");
                                });
                        });
                });
        } else {
                throw new Error("No open serial port");
        }
});

// 📂 Start CSV recording for a given port
ipcMain.handle('start-csv-record', async (event, { path, filePath, separator, eol, order = 'old', addHeader = true, timestampMode = 'none' }) => {
        const port = openPorts.get(path);
        if (!port) {
                throw new Error('port not open');
        }
        if (activeRecordings.has(path)) {
                return 'already recording';
        }
        const sep = separator || ',';
        const eolStr = eol ? JSON.parse(`"${eol}"`) : '\n';
        const headers = headerBuffers.get(path) || [];
        const recording = {
                order,
                addHeader,
                timestampMode,
                lines: [],
                headerLine: null,
                stream: null,
                listener: null,
                startTime: Date.now(),
                headerWritten: false,
                filePath,
                sep,
                eolStr,
                headers
        };

        if (order === 'old') {
                recording.stream = fs.createWriteStream(filePath, { flags: 'a' });
        }

        let buffer = '';
        const listener = chunk => {
                buffer += chunk.toString();
                const lines = buffer.split(eolStr);
                buffer = lines.pop();
                for (const line of lines) {
                        const values = parseLineCustom(line, sep);
                        if (!values.length) continue;

                        if (addHeader && !recording.headerWritten) {
                                const header = [];
                                if (timestampMode !== 'none') {
                                        header.push(timestampMode === 'relative' ? 'time_ms' : 'timestamp');
                                }
                                for (let i = 0; i < values.length; i++) {
                                        const label = recording.headers[i] || `ch${i + 1}`;
                                        header.push(label);
                                }
                                const headerLine = header.join(',');
                                if (order === 'old') {
                                        recording.stream.write(headerLine + '\n');
                                } else {
                                        recording.headerLine = headerLine;
                                }
                                recording.headerWritten = true;
                        }

                        const row = [];
                        if (timestampMode === 'relative') {
                                row.push(String(Date.now() - recording.startTime));
                        } else if (timestampMode === 'absolute') {
                                row.push(new Date().toISOString());
                        }
                        row.push(...values);

                        const lineStr = row.join(',');
                        if (order === 'old') {
                                recording.stream.write(lineStr + '\n');
                        } else {
                                recording.lines.unshift(lineStr);
						}
                }
        };
		recording.listener = listener;
        port.on('data', listener);
        activeRecordings.set(path, recording);
		return 'started';
});

// 🛑 Stop CSV recording for a port
ipcMain.handle('stop-csv-record', async (event, { path }) => {
        const rec = activeRecordings.get(path);
        if (!rec) return 'not recording';
        const port = openPorts.get(path);
        if (port) port.off('data', rec.listener);

        if (rec.order === 'old') {
                await new Promise(res => rec.stream.end(res));
        } else {
                const outLines = [];
                if (rec.headerLine) outLines.push(rec.headerLine);
                outLines.push(...rec.lines);
                const content = outLines.join('\n') + '\n';
                await fs.promises.writeFile(rec.filePath, content);
        }
        activeRecordings.delete(path);
        return 'stopped';
});

// 📂 Open a dialog to choose a firmware binary file
ipcMain.handle('choose-firmware-file', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [{ name: 'Firmware', extensions: ['bin'] }]
    });
    if (canceled || filePaths.length === 0) {
        return null;
    }
    return filePaths[0];
});

// 🔥 Flash firmware to a board over serial
ipcMain.handle('start-flash', async (event, { comPort, firmwarePath, mcumgrPath: userPath }) => {
    const existing = openPorts.get(comPort);
    if (existing && existing.isOpen) {
        await new Promise(res => existing.close(err => {
            if (err) {
                console.error('Error closing port before flash:', err.message);
            }
            res();
        }));
    }

    return new Promise(resolve => {
        flashFirmware(
            { comPort, firmwarePath, mcumgrPath: userPath || mcumgrPath },
            msg => event.sender.send('flash-progress', msg),
            () => event.sender.send('flash-complete')
        );
        resolve();
    });
});

// ❌ Cancel flashing
ipcMain.on('cancel-flash', () => {
    cancelFlash();
});

// 🧹 Flush buffers for a serial port
ipcMain.handle('flush-serial-buffers', async (_event, { path }) => {
    terminalBuffers.set(path, []);
    serialBuffers.set(path, []);
    headerBuffers.set(path, []);
    colorBuffers.set(path, []);
    fastStates.delete(path);
    fastBuffers.delete(path);
    return 'flushed';
});

// ❓ Check if a serial port is open
ipcMain.handle('is-serial-port-open', async (_event, { path }) => {
    const port = openPorts.get(path);
    return port ? port.isOpen : false;
});
