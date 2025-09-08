// Translation of python/thingset_bin.py
// ThingSet binary protocol over CAN with ISO-TP TX/RX
// Requires: socketcan (Linux), cbor (npm), and a CAN bus adapter implementation
// Windows support via ffi-napi is sketched in js/can_adapter.js

'use strict';

const cbor = require('cbor');

function makeCanId(targetAddr, sourceAddr) {
  // ThingSet type 0x0 (request/response) layout with bus numbers = 0
  const priority = 0x6 << 26;
  const type = 0x0 << 24;
  const buses = 0x00 << 16; // target/source bus = 0
  return (priority | type | buses | ((targetAddr & 0xff) << 8) | (sourceAddr & 0xff)) >>> 0;
}

const STATUS_TEXT = {
  0x80: 'OK',
  0x81: 'Created',
  0x82: 'Deleted',
  0x84: 'Changed',
  0x85: 'Content',
  0xA3: 'Forbidden',
  0xA4: 'Not Found',
  0xAF: 'Unsupported Type',
  0xA0: 'No Response (timeout)', // synthetic
};

const _SF = 0x00;
const _FF = 0x10;
const _CF = 0x20;
const _FC = 0x30;

function _stminToSeconds(stmin) {
  if (stmin >= 0x00 && stmin <= 0x7F) return stmin / 1000.0;
  if (stmin >= 0xF1 && stmin <= 0xF9) return (stmin - 0xF0) / 10000.0;
  return 0.0;
}

const GET = 0x01;
const EXEC = 0x02;
const DELETE = 0x04;
const FETCH = 0x05;
const CREATE = 0x06;
const UPDATE = 0x07;

function _encodeEndpoint(ep) {
  // ep can be string, number, or [number, number]
  if (Array.isArray(ep) && ep.length === 2 && ep.every((x) => Number.isInteger(x))) {
    return cbor.encode([ep[0], ep[1]]);
  }
  return cbor.encode(ep);
}

class ThingSetResponse {
  constructor(status, nodeId, payloadBytes, payloadDecoded) {
    this.status = status | 0;
    this.status_hex = `0x${(status | 0).toString(16).toUpperCase().padStart(2, '0')}`;
    this.status_text = STATUS_TEXT[this.status] || 'Unknown';
    this.node_id = nodeId;
    this.payload_bytes = payloadBytes || null;
    this.payload = payloadDecoded;
  }
  ok() { return [0x80, 0x81, 0x82, 0x84, 0x85].includes(this.status); }
  summary() { return `${this.status_hex} ${this.status_text}`; }
}

function _parseThingSetResponse(tsBytes) {
  if (!tsBytes || tsBytes.length === 0) return new ThingSetResponse(0xA0, null, null, null);
  const status = tsBytes[0];
  try {
    const objs = cbor.decodeAllSync(tsBytes.slice(1));
    const nodeId = objs.length > 0 ? objs[0] : null;
    const payloadObj = objs.length > 1 ? objs[1] : null;
    // payload_bytes best-effort: re-encode decoded payload if present
    const payloadBytes = payloadObj !== null && payloadObj !== undefined ? cbor.encode(payloadObj) : null;
    return new ThingSetResponse(status, nodeId, payloadBytes, payloadObj);
  } catch {
    return new ThingSetResponse(status, null, null, null);
  }
}

async function _isotpSend(bus, srcAddr, dstAddr, appPayload, fcWaitTimeoutMs = 500) {
  const txId = makeCanId(dstAddr, srcAddr);
  const rxFcId = makeCanId(srcAddr, dstAddr);
  const payload = Buffer.isBuffer(appPayload) ? appPayload : Buffer.from(appPayload || []);

  if (payload.length <= 7) {
    const sf = Buffer.concat([Buffer.from([payload.length & 0x0F]), payload]);
    await bus.send({ arbitration_id: txId, data: sf, is_extended_id: true });
    return;
  }

  // First frame (FF)
  const totalLen = payload.length;
  const ffLenHi = (totalLen >> 8) & 0x0F;
  const ffLenLo = totalLen & 0xFF;
  const firstChunk = payload.slice(0, 6);
  let ff = Buffer.from([_FF | ffLenHi, ffLenLo]);
  ff = Buffer.concat([ff, firstChunk]);
  if (ff.length < 8) ff = Buffer.concat([ff, Buffer.alloc(8 - ff.length, 0)]);
  await bus.send({ arbitration_id: txId, data: ff, is_extended_id: true });

  // Wait for Flow Control (FC)
  const start = Date.now();
  let bs = 0;
  let stmin_s = 0.0;
  while (true) {
    const msg = await bus.recv(fcWaitTimeoutMs);
    if (!msg || msg.arbitration_id !== rxFcId) {
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
    if (fcStatus === 0x1) { // Wait
      continue; // refresh wait
    }
    bs = d[1] & 0xFF;
    stmin_s = _stminToSeconds(d[2] & 0xFF);
    break;
  }

  // Send Consecutive Frames
  let seq = 1;
  let sentInBlock = 0;
  let offset = 6;
  while (offset < totalLen) {
    const chunk = payload.slice(offset, offset + 7);
    const pci = _CF | (seq & 0x0F);
    let cf = Buffer.concat([Buffer.from([pci]), chunk]);
    if (cf.length < 8) cf = Buffer.concat([cf, Buffer.alloc(8 - cf.length, 0)]);
    await bus.send({ arbitration_id: txId, data: cf, is_extended_id: true });
    offset += chunk.length;
    seq = (seq + 1) & 0x0F;
    sentInBlock += 1;

    if (stmin_s > 0) await new Promise((r) => setTimeout(r, Math.floor(stmin_s * 1000)));

    if (bs !== 0 && sentInBlock >= bs && offset < totalLen) {
      sentInBlock = 0;
      const blockStart = Date.now();
      while (true) {
        const msg = await bus.recv(fcWaitTimeoutMs);
        if (!msg || msg.arbitration_id !== rxFcId) {
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
        stmin_s = _stminToSeconds(d[2] & 0xFF);
        break;
      }
    }
  }
}

async function _sendFlowControlCTS(bus, ourAddr, nodeAddr, bs = 0x00, stmin = 0x00) {
  const fcId = makeCanId(nodeAddr, ourAddr);
  const data = Buffer.from([_FC, bs & 0xff, stmin & 0xff, 0, 0, 0, 0, 0]);
  await bus.send({ arbitration_id: fcId, data, is_extended_id: true });
}

async function _isotpRecv(bus, srcAddr, dstAddr, frameTimeoutMs = 250, overallTimeoutMs = 2000) {
  const rxId = makeCanId(dstAddr, srcAddr);
  // Drain until expected ID appears
  const deadline = Date.now() + overallTimeoutMs;
  let first = null;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const msg = await bus.recv(remaining, (m) => m.arbitration_id === rxId);
    if (!msg) break;
    first = msg;
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
    await _sendFlowControlCTS(bus, dstAddr, srcAddr, 0x00, 0x00);
    const deadline = Date.now() + overallTimeoutMs;
    while (buf.length < totalLen && Date.now() < deadline) {
      const frame = await bus.recv(frameTimeoutMs, (m) => m.arbitration_id === rxId);
      if (!frame) continue;
      const cd = frame.data.slice(0, frame.dlc);
      if ((cd[0] & 0xF0) !== _CF) continue;
      buf = Buffer.concat([buf, cd.slice(1)]);
    }
    return buf.slice(0, totalLen);
  }
  return null;
}

class ThingSetCAN {
  constructor(bus, sourceAddr = 0xEF) {
    this.bus = bus;
    this.sourceAddr = sourceAddr | 0;
  }

  async transceive(targetAddr, tsPayload, rxFrameTimeoutMs = 250, rxOverallTimeoutMs = 2000) {
    await _isotpSend(this.bus, this.sourceAddr, targetAddr, tsPayload);
    const rx = await _isotpRecv(this.bus, targetAddr, this.sourceAddr, rxFrameTimeoutMs, rxOverallTimeoutMs);
    return _parseThingSetResponse(rx || Buffer.alloc(0));
  }

  async get(targetAddr, endpoint, rxOverallTimeoutMs = 2000) {
    const pdu = Buffer.concat([Buffer.from([GET]), _encodeEndpoint(endpoint)]);
    return this.transceive(targetAddr, pdu, 250, rxOverallTimeoutMs);
  }

  async fetch(targetAddr, endpoint, items = null, rxOverallTimeoutMs = 2000) {
    let pdu;
    if (items == null) {
      // CBOR null = 0xF6
      pdu = Buffer.concat([Buffer.from([FETCH]), _encodeEndpoint(endpoint), Buffer.from([0xF6])]);
    } else {
      pdu = Buffer.concat([Buffer.from([FETCH]), _encodeEndpoint(endpoint), cbor.encode([...items])]);
    }
    return this.transceive(targetAddr, pdu, 250, rxOverallTimeoutMs);
  }

  async update(targetAddr, endpoint, valuesMap, rxOverallTimeoutMs = 2000) {
    const pdu = Buffer.concat([Buffer.from([UPDATE]), _encodeEndpoint(endpoint), cbor.encode(valuesMap)]);
    return this.transceive(targetAddr, pdu, 250, rxOverallTimeoutMs);
  }

  async create(targetAddr, endpoint, value, rxOverallTimeoutMs = 2000) {
    const pdu = Buffer.concat([Buffer.from([CREATE]), _encodeEndpoint(endpoint), cbor.encode(value)]);
    return this.transceive(targetAddr, pdu, 250, rxOverallTimeoutMs);
  }

  async delete(targetAddr, endpoint, value, rxOverallTimeoutMs = 2000) {
    const pdu = Buffer.concat([Buffer.from([DELETE]), _encodeEndpoint(endpoint), cbor.encode(value)]);
    return this.transceive(targetAddr, pdu, 250, rxOverallTimeoutMs);
  }

  async exec(targetAddr, endpoint, args = [], rxOverallTimeoutMs = 2000) {
    const arr = Array.isArray(args) ? args : [];
    const pdu = Buffer.concat([Buffer.from([EXEC]), _encodeEndpoint(endpoint), cbor.encode(arr)]);
    return this.transceive(targetAddr, pdu, 250, rxOverallTimeoutMs);
  }

  async paths_for_ids(targetAddr, ids, rxOverallTimeoutMs = 2000) {
    const pdu = Buffer.concat([Buffer.from([FETCH]), cbor.encode(0x17), cbor.encode([...ids])]);
    return this.transceive(targetAddr, pdu, 250, rxOverallTimeoutMs);
  }

  async ids_for_paths(targetAddr, paths, rxOverallTimeoutMs = 2000) {
    const pdu = Buffer.concat([Buffer.from([FETCH]), cbor.encode(0x16), cbor.encode([...paths])]);
    return this.transceive(targetAddr, pdu, 250, rxOverallTimeoutMs);
  }
}

module.exports = {
  ThingSetCAN,
  makeCanId,
};
