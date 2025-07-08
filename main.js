const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { SerialPort } = require('serialport');

const openPorts = new Map(); // key: path, value: SerialPort instance
let serialBuffer = [];
const MAX_BUFFER_SIZE = 1000;

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

function createWindow() {
	const win = new BrowserWindow({
		width: 1280,
		height: 800,
		webPreferences: {
			nodeIntegration: true,
			contextIsolation: false
		}
	});
	win.loadFile(path.join(__dirname, 'dashboard/index.html'));
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

	port.on("data", chunk => {
		rawBuffer += chunk.toString();
		const lines = rawBuffer.split(currentSettings.eol);
		rawBuffer = lines.pop(); // keep the last (possibly incomplete) line
    for (const line of lines) {
      const parsed = parseLine(line);
      if (parsed.length) addToBuffer(parsed);
    }
	});

	port.on("error", err => {
		console.error("Serial port error:", err.message);
	});

	port.on("close", () => {
		console.log(`🔌 Serial port ${path} closed.`);
		openPorts.delete(path);
	});

	openPorts.set(path, port);
});

// 📥 Renderer pulls latest parsed data
ipcMain.handle("get-serial-buffer", () => {
	return serialBuffer.length > 0 ? serialBuffer[serialBuffer.length - 1] : [];
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