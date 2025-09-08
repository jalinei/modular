'use strict';

// ThingSet CAN DFU tool (JS translation of thingset-dfu-can.py)
// - Uses raw SocketCAN via js/can_adapter.js
// - Implements minimal ISO-TP send/recv for extended CAN IDs
// - Sends ThingSet EXEC calls for DFU: xInit, xWrite, xBoot

const fs = require('fs');
const path = require('path');
const cbor = require('cbor');
const { createBus } = require('./can_adapter');

// ---------- CLI args parsing ----------
function parseIntAuto(str, def) {
  if (str == null) return def;
  if (typeof str === 'number') return str | 0;
  const s = String(str).trim();
  if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s, 16);
  return parseInt(s, 10);
}

function parseArgs(argv) {
  const out = {
    filename: null,
    can: 'can0',
    target: 0xa0,
    source: 0x00,
    targetBus: 0x0,
    sourceBus: 0x0,
  };

  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a || a === '--') break;
    if (!a.startsWith('-')) { out.filename = a; continue; }
    if (a === '-c' || a === '--can') { out.can = args[++i]; continue; }
    if (a === '-t' || a === '--target') { out.target = parseIntAuto(args[++i], out.target); continue; }
    if (a === '-s' || a === '--source') { out.source = parseIntAuto(args[++i], out.source); continue; }
    if (a === '-tb' || a === '--target-bus') { out.targetBus = parseIntAuto(args[++i], out.targetBus); continue; }
    if (a === '-sb' || a === '--source-bus') { out.sourceBus = parseIntAuto(args[++i], out.sourceBus); continue; }
    if (a === '-h' || a === '--help') { out.help = true; continue; }
  }
  return out;
}

function printHelp() {
  console.log('ThingSet CAN DFU tool');
  console.log('Usage: node js/thingset_dfu_can.js <filename> [options]');
  console.log('Options:');
  console.log('  -c, --can <if>         CAN interface (default: can0)');
  console.log('  -t, --target <addr>    Target CAN node address (default: 0xA0)');
  console.log('  -s, --source <addr>    Source CAN node address (default: 0x00)');
  console.log('  -tb, --target-bus <n>  Target CAN bus number 0..15 (default: 0)');
  console.log('  -sb, --source-bus <n>  Source CAN bus number 0..15 (default: 0)');
}

// ---------- CAN ID helpers (ThingSet layout) ----------
// 29-bit extended ID layout for ThingSet request/response (type 0x0)
// Bits 28..26: priority = 0x6
// Bits 25..24: type     = 0x0
// Bits 23..20: target bus (0..15)
// Bits 19..16: source bus (0..15)
// Bits 15..8 : target node address (1..253)
// Bits 7..0  : source node address (0..253)
function makeTsCanId(targetBus, sourceBus, targetAddr, sourceAddr) {
  const priority = 0x6 << 26;
  const type = 0x0 << 24;
  const buses = ((targetBus & 0xF) << 20) | ((sourceBus & 0xF) << 16);
  const addrs = ((targetAddr & 0xFF) << 8) | (sourceAddr & 0xFF);
  return (priority | type | buses | addrs) >>> 0;
}

// ---------- Minimal ISO-TP over raw CAN ----------
const _SF = 0x00;
const _FF = 0x10;
const _CF = 0x20;
const _FC = 0x30;

function _stminToMs(stmin) {
  if (stmin >= 0x00 && stmin <= 0x7F) return Math.ceil(stmin);
  if (stmin >= 0xF1 && stmin <= 0xF9) return Math.ceil((stmin - 0xF0) * 0.1);
  return 0;
}

async function isotpSend(bus, targetBus, sourceBus, srcAddr, dstAddr, payload, fcWaitTimeoutMs = 500) {
  const txId = makeTsCanId(targetBus, sourceBus, dstAddr, srcAddr);
  const rxFcId = makeTsCanId(sourceBus, targetBus, srcAddr, dstAddr);
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);

  if (p.length <= 7) {
    const sf = Buffer.concat([Buffer.from([p.length & 0x0F]), p]);
    await bus.send({ arbitration_id: txId, data: sf, is_extended_id: true });
    return;
  }

  const totalLen = p.length;
  const ffLenHi = (totalLen >> 8) & 0x0F;
  const ffLenLo = totalLen & 0xFF;
  const firstChunk = p.slice(0, 6);
  let ff = Buffer.from([_FF | ffLenHi, ffLenLo]);
  ff = Buffer.concat([ff, firstChunk]);
  if (ff.length < 8) ff = Buffer.concat([ff, Buffer.alloc(8 - ff.length, 0)]);
  await bus.send({ arbitration_id: txId, data: ff, is_extended_id: true });

  // Wait for Flow Control (FC)
  const start = Date.now();
  let bs = 0;
  let stmin_ms = 0;
  while (true) {
    const msg = await bus.recv(fcWaitTimeoutMs, (m) => m && m.arbitration_id === rxFcId);
    if (!msg) {
      if (Date.now() - start >= fcWaitTimeoutMs) throw new Error('ISO-TP: FC not received');
      continue;
    }
    const d = msg.data.slice(0, msg.dlc);
    if ((d[0] & 0xF0) !== _FC) {
      if (Date.now() - start >= fcWaitTimeoutMs) throw new Error('ISO-TP: FC not received');
      continue;
    }
    const fcStatus = d[0] & 0x0F; // 0x0=CTS, 0x1=Wait, 0x2=Overflow
    if (fcStatus === 0x2) throw new Error('ISO-TP: Receiver overflow');
    if (fcStatus === 0x1) continue; // Wait => read again
    bs = d[1] & 0xFF;
    stmin_ms = _stminToMs(d[2] & 0xFF);
    break;
  }

  let seq = 1;
  let offset = 6;
  let sentInBlock = 0;
  while (offset < totalLen) {
    const chunk = p.slice(offset, offset + 7);
    const pci = _CF | (seq & 0x0F);
    let cf = Buffer.concat([Buffer.from([pci]), chunk]);
    if (cf.length < 8) cf = Buffer.concat([cf, Buffer.alloc(8 - cf.length, 0)]);
    await bus.send({ arbitration_id: txId, data: cf, is_extended_id: true });
    offset += chunk.length;
    seq = (seq + 1) & 0x0F;
    sentInBlock += 1;
    if (stmin_ms > 0) await new Promise((r) => setTimeout(r, stmin_ms));

    if (bs !== 0 && sentInBlock >= bs && offset < totalLen) {
      sentInBlock = 0;
      const blockStart = Date.now();
      while (true) {
        const msg = await bus.recv(fcWaitTimeoutMs, (m) => m && m.arbitration_id === rxFcId);
        if (!msg) {
          if (Date.now() - blockStart >= fcWaitTimeoutMs) throw new Error('ISO-TP: Next FC not received');
          continue;
        }
        const d = msg.data.slice(0, msg.dlc);
        if ((d[0] & 0xF0) !== _FC) {
          if (Date.now() - blockStart >= fcWaitTimeoutMs) throw new Error('ISO-TP: Next FC not received');
          continue;
        }
        const fcStatus = d[0] & 0x0F;
        if (fcStatus === 0x2) throw new Error('ISO-TP: Receiver overflow');
        if (fcStatus === 0x1) continue; // Wait
        bs = d[1] & 0xFF;
        stmin_ms = _stminToMs(d[2] & 0xFF);
        break;
      }
    }
  }
}

async function isotpRecv(bus, targetBus, sourceBus, srcAddr, dstAddr, frameTimeoutMs = 300, overallTimeoutMs = 3000) {
  const rxId = makeTsCanId(sourceBus, targetBus, srcAddr, dstAddr);
  const deadline = Date.now() + overallTimeoutMs;

  // Wait for first frame from responder
  let first = null;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const m = await bus.recv(remaining, (msg) => msg && msg.arbitration_id === rxId);
    if (!m) continue;
    first = m;
    break;
  }
  if (!first) return null;

  const d = first.data.slice(0, first.dlc);
  const pci = d[0] & 0xF0;

  if (pci === _SF) {
    const length = d[0] & 0x0F;
    return Buffer.from(d.slice(1, 1 + length));
  }

  if (pci === _FF) {
    const totalLen = ((d[0] & 0x0F) << 8) | d[1];
    let buf = Buffer.from(d.slice(2));
    // Send FC CTS, unlimited block, STmin=0
    const fcId = makeTsCanId(targetBus, sourceBus, dstAddr, srcAddr);
    const fcData = Buffer.from([_FC, 0x00, 0x00, 0, 0, 0, 0, 0]);
    await bus.send({ arbitration_id: fcId, data: fcData, is_extended_id: true });

    let expectedSeq = 1;
    while (buf.length < totalLen && Date.now() < deadline) {
      const m = await bus.recv(frameTimeoutMs, (msg) => msg && msg.arbitration_id === rxId);
      if (!m) continue;
      const cd = m.data.slice(0, m.dlc);
      if ((cd[0] & 0xF0) !== _CF) continue;
      const gotSeq = cd[0] & 0x0F;
      if (gotSeq !== (expectedSeq & 0x0F)) {
        // resync rather than abort
        expectedSeq = gotSeq;
      }
      buf = Buffer.concat([buf, cd.slice(1)]);
      expectedSeq += 1;
    }
    return buf.slice(0, totalLen);
  }

  return null;
}

// ---------- ThingSet DFU helpers ----------
const EXEC = 0x02;

function encodeEndpoint(ep) { return cbor.encode(ep); }

async function tsExec(bus, targetBus, sourceBus, srcAddr, dstAddr, endpoint, argsArray, timeoutsMs = { frame: 300, overall: 3000 }) {
  const argsBuf = cbor.encode(Array.isArray(argsArray) ? argsArray : []);
  const pdu = Buffer.concat([Buffer.from([EXEC]), encodeEndpoint(endpoint), argsBuf]);
  await isotpSend(bus, targetBus, sourceBus, srcAddr, dstAddr, pdu);
  const rx = await isotpRecv(bus, targetBus, sourceBus, srcAddr, dstAddr, timeoutsMs.frame, timeoutsMs.overall);
  if (!rx) return { status: 0xA0, status_text: 'No Response', payload: null };
  const status = rx[0] & 0xFF;
  let decoded = null;
  try {
    const arr = cbor.decodeAllSync(rx.slice(1));
    decoded = arr;
  } catch { decoded = null; }
  return { status, payload: decoded };
}

// ---------- Programmatic API ----------
async function flashCanFirmware({
  filename,
  channel = 'can0',
  target = 0xA0,
  source = 0x00,
  targetBus = 0x0,
  sourceBus = 0x0,
  pageSize = 256,
  signal, // optional AbortSignal
}, onProgress) {
  function progress(msg) { if (typeof onProgress === 'function') onProgress(msg); }

  // Validate ranges
  if (!(target >= 0x01 && target <= 0xFD)) throw new Error('Target addresses must be between 0x01 and 0xFD');
  if (!(source >= 0x00 && source <= 0xFD)) throw new Error('Source addresses must be between 0x00 and 0xFD');
  if (!(targetBus >= 0x0 && targetBus <= 0xF)) throw new Error('Target bus must be between 0x0 and 0xF');
  if (!(sourceBus >= 0x0 && sourceBus <= 0xF)) throw new Error('Source bus must be between 0x0 and 0xF');

  const binPath = path.resolve(filename);
  if (!fs.existsSync(binPath)) throw new Error(`File not found: ${binPath}`);

  let bus;
  const start = new Date();
  try {
    bus = await createBus({ channel });
  } catch (e) {
    throw new Error(`Failed to open CAN interface '${channel}': ${e.message || e}`);
  }

  const checkAbort = () => {
    if (signal && signal.aborted) throw new Error('Aborted');
  };

  try {
    progress('Initializing DFU');
    checkAbort();
    const initResp = await tsExec(bus, targetBus, sourceBus, source, target, 0x02D0, []);
    if (initResp.status !== 0x84) throw new Error(`Initializing DFU failed with code 0x${initResp.status.toString(16).toUpperCase()}`);

    const stat = fs.statSync(binPath);
    const totalKiB = Math.ceil(stat.size / 1024);
    let flashed = 0;

    const fd = fs.openSync(binPath, 'r');
    const buffer = Buffer.alloc(pageSize);
    progress(`Flashing ${stat.size} bytes in ${pageSize}-byte pages...`);
    while (true) {
      checkAbort();
      const bytesRead = fs.readSync(fd, buffer, 0, pageSize, null);
      if (bytesRead <= 0) break;
      const chunk = buffer.slice(0, bytesRead);
      const writeResp = await tsExec(bus, targetBus, sourceBus, source, target, 0x02D1, [chunk], { frame: 300, overall: 3000 });
      const ok = writeResp.status === 0x84 && writeResp.payload && writeResp.payload.length >= 2 && typeof writeResp.payload[1] === 'number' && writeResp.payload[1] === 0;
      if (!ok) throw new Error('Firmware upgrade failed');
      flashed += bytesRead;
      const doneKiB = Math.floor(flashed / 1024);
      const percent = Math.floor((flashed / stat.size) * 100);
      progress(`${doneKiB}/${totalKiB} KiB = ${percent}%`);
      await new Promise((r) => setTimeout(r, 10));
    }

    progress('Finishing DFU');
    const bootResp = await tsExec(bus, targetBus, sourceBus, source, target, 0x02D3, []);
    if (bootResp.status !== 0x84) throw new Error(`Finishing DFU failed with code 0x${bootResp.status.toString(16).toUpperCase()}`);

    const stop = new Date();
    const durMs = stop - start;
    const durStr = new Date(durMs).toISOString().substr(11, 8);
    progress(`Total duration: ${durStr}`);
  } finally {
    try { await bus.shutdown(); } catch {}
  }
}

// ---------- CLI entry ----------
async function mainCli() {
  const args = parseArgs(process.argv);
  if (args.help || !args.filename) { printHelp(); process.exit(args.help ? 0 : 1); }
  try {
    await flashCanFirmware({
      filename: args.filename,
      channel: args.can,
      target: args.target,
      source: args.source,
      targetBus: args.targetBus,
      sourceBus: args.sourceBus,
    }, (m) => process.stdout.write((m.endsWith('\n') ? '' : '') + m + '\n'));
  } catch (e) {
    console.error(e && e.message ? e.message : String(e));
    process.exit(1);
  }
}

if (require.main === module) {
  mainCli();
}

module.exports = { flashCanFirmware };
