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
let serialBuffer = [];
const MAX_BUFFER_SIZE = 1000;
const MAX_TERMINAL_LINES = 200;



let currentSettings = {
	separator: ":",
	eol: "\n"
};

function addToBuffer(parsedData) {
	if (!Array.isArray(parsedData)) return;
	serialBuffer.push(parsedData);
	if (serialBuffer.length > MAX_BUFFER_SIZE) {
		serialBuffer.shift();
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

	port.on("data", chunk => {
			rawBuffer += chunk.toString();
			const lines = rawBuffer.split(currentSettings.eol);
			rawBuffer = lines.pop(); // keep the last (possibly incomplete) line
			const termBuf = terminalBuffers.get(path) || [];
			for (const line of lines) {
					const parsed = parseLine(line);
					if (parsed.length) addToBuffer(parsed);
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
	});

	openPorts.set(path, port);
});

// 📥 Renderer pulls latest parsed data
ipcMain.handle("get-serial-buffer", () => {
        return serialBuffer.length > 0 ? serialBuffer[serialBuffer.length - 1] : [];
});

// 📄 Get terminal lines for a port
ipcMain.handle("get-terminal-buffer", (event, { path }) => {
        return terminalBuffers.get(path) || [];
});

// ❌ Close port
ipcMain.handle("close-serial-port", async (event, { path }) => {
	const port = openPorts.get(path);
	if (port && port.isOpen) {
			return new Promise((resolve, reject) => {
					port.close(err => {
							if (err) return reject(err.message);
							openPorts.delete(path);
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
                eolStr
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
                                        header.push(`ch${i + 1}`);
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
ipcMain.handle('start-flash', (event, { comPort, firmwarePath, mcumgrPath: userPath }) => {
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
