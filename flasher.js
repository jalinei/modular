const { SerialPort } = require('serialport');
const { spawn } = require('child_process');

let currentFlashProcess = null;
let aborted = false;

function cleanupCurrentProcess() {
    if (currentFlashProcess && !currentFlashProcess.killed) {
        const sig = process.platform === 'win32' ? 'SIGTERM' : 'SIGINT';
        currentFlashProcess.kill(sig);
        currentFlashProcess = null;
    }
}

function runMcumgrCommand(mcumgrPath, args, onData, onError, onClose) {
    if (aborted) return null;
    currentFlashProcess = spawn(mcumgrPath, args);
    currentFlashProcess.on('error', err => {
        if (onError) onError(`Process error: ${err.message}`);
    });
    currentFlashProcess.stdout.on('data', d => onData && onData(d.toString()));
    currentFlashProcess.stderr.on('data', d => onError && onError(d.toString()));
    currentFlashProcess.on('close', code => {
        currentFlashProcess = null;
        onClose && onClose(code);
    });
    return currentFlashProcess;
}

function flashFirmware({ comPort, firmwarePath, mcumgrPath }, progressCallback, onDone) {
    aborted = false;
    const touchPort = new SerialPort({ path: comPort, baudRate: 1200 }, err => {
        if (err) {
            progressCallback && progressCallback(`Error: Could not open port at 1200 baud. ${err.message}`);
            onDone && onDone();
            return;
        }
        touchPort.close(closeErr => {
            if (closeErr) {
                progressCallback && progressCallback(`Error: Failed to close 1200 baud port. ${closeErr.message}`);
                onDone && onDone();
                return;
            }
            progressCallback && progressCallback('Serial port touched at 1200 baud. Waiting for bootloader…');
            setTimeout(() => {
                runMcumgrCommand(
                    mcumgrPath,
                    ['conn','add','serial','type=serial',`connstring=dev=${comPort},baud=115200,mtu=128`],
                    progressCallback,
                    progressCallback,
                    code => {
                        if (code !== 0) {
                            progressCallback && progressCallback('Error: Failed to add connection.');
                            cleanupCurrentProcess();
                            onDone && onDone();
                            return;
                        }
                        runMcumgrCommand(
                            mcumgrPath,
                            ['-c','serial','image','upload',firmwarePath],
                            progressCallback,
                            progressCallback,
                            code => {
                                if (code !== 0) {
                                    progressCallback && progressCallback('Error: Firmware upload failed.');
                                    cleanupCurrentProcess();
                                    onDone && onDone();
                                    return;
                                }
                                runMcumgrCommand(
                                    mcumgrPath,
                                    ['-c','serial','reset'],
                                    progressCallback,
                                    progressCallback,
                                    code => {
                                        if (code !== 0) {
                                            progressCallback && progressCallback('Error: Reset failed.');
                                        } else {
                                            progressCallback && progressCallback('Success: Flashing and reset complete!');
                                        }
                                        cleanupCurrentProcess();
                                        onDone && onDone();
                                    }
                                );
                            }
                        );
                    }
                );
            }, 500);
        });
    });
}

function cancelFlash() {
    aborted = true;
    if (currentFlashProcess) {
        const sig = process.platform === 'win32' ? 'SIGTERM' : 'SIGINT';
        currentFlashProcess.kill(sig);
        currentFlashProcess = null;
    }
}

module.exports = { flashFirmware, cancelFlash };
