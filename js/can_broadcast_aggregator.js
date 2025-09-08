'use strict';

// Aggregates ThingSet broadcast reports over CAN into per-node value maps.
//
// Protocol compliance (ThingSet over CAN):
// - Uses extended 29-bit IDs only.
// - Report frame types:
//   • Multi-frame reports: type 0x1, priorities 5 or 7. Reassemble by (addr,msgNo),
//     using MF type (first/cons/last/single) and sequence number. Payload bytes
//     are raw ThingSet report data (CBOR for binary mode). Last frame may be
//     padded with 0x00, which must be ignored.
//   • Single-frame reports: type 0x2, priorities 5 or 7. CAN ID encodes the
//     16-bit Data Item ID (not in CBOR). Payload is the CBOR-encoded value,
//     optionally followed by a 16-bit rolling timestamp. We decode the value and
//     ignore any trailing timestamp.
// - Records in reports are encoded as two CBOR items: first an array [parentId, index],
//   then a map { fieldId: value, ... }. We track the header per source address and
//   associate the subsequent map with the specified record.

const fs = require('fs');
const path = require('path');
const cbor = require('cbor');

// Helpers to extract fields from 29-bit CAN ID
function getPriority(id) { return (id >>> 26) & 0x7; }
function getType(id) { return (id >>> 24) & 0x3; }
function getSourceAddr(id) { return id & 0xFF; }

// Multi-frame (type 0x1) fields
function getMsgNo(id) { return (id >>> 14) & 0x3; }
function getMfType(id) { return (id >>> 12) & 0x3; } // 0:first, 1:consecutive, 2:last, 3:single
function getSeqNo(id) { return (id >>> 8) & 0xF; }

function isMfReport(id) {
  const prio = getPriority(id);
  return getType(id) === 0x1 && (prio === 5 || prio === 7);
}

function isSfReport(id) {
  const prio = getPriority(id);
  return getType(id) === 0x2 && (prio === 5 || prio === 7);
}

function nodeAddrFromId(arbitration_id) { return getSourceAddr(arbitration_id); }

function hexAddr(n) {
  return `0x${(n >>> 0).toString(16).toUpperCase().padStart(2, '0')}`;
}

// Build a numeric-id -> path mapping from a ThingSet tree JSON (node_*_tree.json)
function buildIdToPathMap(tree) {
  const map = new Map();
  function walk(obj, curPath) {
    if (!obj || typeof obj !== 'object') return;
    const idHex = obj.id || null;
    const p = obj.path || curPath || null;
    if (idHex && typeof idHex === 'string') {
      const idNum = parseInt(idHex.replace(/^0x/i, ''), 16);
      if (Number.isFinite(idNum)) {
        if (p) map.set(idNum, p);
      }
    }
    if (obj.children && typeof obj.children === 'object') {
      for (const [name, child] of Object.entries(obj.children)) {
        const childPath = child && child.path ? child.path : (p ? `${p}/${name}` : name);
        walk(child, childPath);
      }
    }
    if (obj.values && typeof obj.values === 'object') {
      // values may already be a map keyed by idHex or names; still traverse
      for (const [k, v] of Object.entries(obj.values)) {
        if (v && typeof v === 'object') walk(v, p ? `${p}/${k}` : k);
      }
    }
    if (Array.isArray(obj.records)) {
      for (const rec of obj.records) walk(rec, p);
    }
  }
  walk(tree && tree.root ? tree.root : tree, null);
  return map; // Map<number, string>
}

class CanBroadcastAggregator {
  constructor(bus, { channel = 'can0' } = {}) {
    this.bus = bus;
    this.channel = channel;
    this.running = false;
    this.debug = (process.env.CAN_AGG_DEBUG === '1' || process.env.CAN_DEBUG === '1');
    this.listeners = new Set();
    // Reassembly state for multi-frame reports: key `${addr}:${msgNo}` -> { chunks: [Buffer,...] }
    this.mf = new Map();
    // Pending record header per addr: { parentId, index }
    this.pendingRecord = new Map();
    this.snap = {
      channel,
      nodes: {}, // addrHex -> { ts, lastCount, groups: { [groupIdHex]: { [idHex]: val } }, flat: { [path|idHex]: val } }
    };
    this.idToPath = new Map(); // addrNum -> Map<number,string>
    this.busOnMessage = this.onMessage.bind(this);
  }

  setDebug(enable) {
    this.debug = !!enable;
  }

  dlog(...args) {
    if (this.debug) {
      try { console.log('[CAN AGG]', ...args); } catch { /* ignore */ }
    }
  }

  async ensureMappingFor(addr) {
    if (this.idToPath.has(addr)) return;
    try {
      const file = path.join(process.cwd(), 'thingset', `node_${(addr).toString(16).toUpperCase().padStart(2, '0')}_tree.json`);
      const txt = await fs.promises.readFile(file, 'utf8');
      const json = JSON.parse(txt);
      this.idToPath.set(addr, buildIdToPathMap(json));
    } catch {
      this.idToPath.set(addr, new Map());
    }
  }

  start() {
    if (this.running) return;
    // Subscribe to bus frames (socketcan raw channel emits 'onMessage')
    if (typeof this.bus.addListener === 'function') this.bus.addListener('onMessage', this.busOnMessage);
    else if (typeof this.bus.on === 'function') this.bus.on('onMessage', this.busOnMessage);
    this.running = true;
  }

  stop() {
    if (!this.running) return;
    try {
      if (typeof this.bus.removeListener === 'function') this.bus.removeListener('onMessage', this.busOnMessage);
      else if (typeof this.bus.off === 'function') this.bus.off('onMessage', this.busOnMessage);
      else if (typeof this.bus.removeAllListeners === 'function') this.bus.removeAllListeners('onMessage');
    } catch { /* ignore */ }
    this.running = false;
  }

  getSnapshot() {
    return this.snap;
  }

  onMessage(frame) {
    try {
      const id = frame.id >>> 0;
      if (!frame.ext && !frame.is_extended_id && !(id > 0x7FF)) return;
      const addr = nodeAddrFromId(id) >>> 0;
      const data = Buffer.from(frame.data || []);
      if (!data.length) return;

      if (isMfReport(id)) {
        // Handle multi-frame report reassembly per (addr,msgNo)
        const msgNo = getMsgNo(id);
        const mfType = getMfType(id);
        const key = `${addr}:${msgNo}`;
        const seq = getSeqNo(id);
        this.dlog(`MF frame prio=${getPriority(id)} type=${mfType} msg=${msgNo} seq=${seq} addr=${hexAddr(addr)} len=${data.length} id=0x${id.toString(16).toUpperCase()}`);
        if (mfType === 0x0) { // first
          this.mf.set(key, { chunks: [data] });
          return;
        } else if (mfType === 0x1) { // consecutive
          const st = this.mf.get(key);
          if (st) st.chunks.push(data);
          else {
            // Missing start; start anyway to not lose data
            this.mf.set(key, { chunks: [data] });
          }
          return;
        } else if (mfType === 0x2) { // last
          const st = this.mf.get(key);
          const chunks = st ? st.chunks.concat([data]) : [data];
          this.mf.delete(key);
          const payload = Buffer.concat(chunks);
          this.dlog(`MF complete addr=${hexAddr(addr)} bytes=${payload.length}`);
          this.decodeAndProcess(addr, payload);
          return;
        } else if (mfType === 0x3) { // single
          this.dlog(`MF single addr=${hexAddr(addr)} len=${data.length}`);
          this.decodeAndProcess(addr, data);
          return;
        }
      } else if (isSfReport(id)) {
        // Single-frame report with Data Item ID encoded in CAN ID; payload is CBOR value + optional 16-bit timestamp
        // Bits 23..8: Data item ID (MSB first)
        const itemId = (id >>> 8) & 0xFFFF;
        // Decode first CBOR item from data and ignore trailing timestamp if present
        try {
          // Decode only the first CBOR item; ignore trailing timestamp bytes if present
          this.dlog(`SF report addr=${hexAddr(addr)} itemId=0x${itemId.toString(16).toUpperCase().padStart(2, '0')} len=${data.length}`);
          const value = cbor.decodeFirstSync(data);
          this.onDecodedItems(addr, [{ __singleId: itemId, __value: value }]);
        } catch { /* ignore malformed */ }
        return;
      } else {
        // Not a report we care about
        return;
      }
    } catch { /* ignore */ }
  }

  decodeAndProcess(addr, payload) {
    // Trim trailing 0x00 padding
    let end = payload.length;
    while (end > 0 && payload[end - 1] === 0x00) end--;
    let buf = payload.slice(0, end);
    // Some devices prepend a non-CBOR leading marker 0x1F before a sequence of CBOR items.
    // If present, strip it so the first item starts at a valid CBOR major type byte.
    if (buf.length && buf[0] === 0x1F) {
      this.dlog('Stripping leading 0x1F marker before CBOR items');
      buf = buf.slice(1);
    }
    if (!buf.length) return;
    try {
      const items = cbor.decodeAllSync(buf);
      this.dlog(`Decoded ${items?.length || 0} CBOR item(s) for addr=${hexAddr(addr)}`);
      if (items && items.length) this.onDecodedItems(addr, items);
    } catch (e) {
      this.dlog(`CBOR decode failed for addr=${hexAddr(addr)}: ${e?.message || e}`);
      try { this.dlog('Payload HEX:', buf.toString('hex')); } catch {}
      // Debug-friendly fallback: if payload looks like raw 32-bit floats, parse sequentially
      if (this.debug && buf.length >= 8 && buf.length % 4 === 0 && buf.length / 4 <= 64) {
        try {
          const n = buf.length / 4;
          const idMap = {};
          for (let i = 0; i < n; i++) {
            // Try BE first (ThingSet uses network byte order); if NaN/Inf, try LE
            let v = buf.readFloatBE(i * 4);
            if (!Number.isFinite(v)) v = buf.readFloatLE(i * 4);
            idMap[i + 1] = v;
          }
          this.dlog(`Fallback parsed ${Object.keys(idMap).length} float(s) for addr=${hexAddr(addr)}`);
          // Wrap like a group map under a pseudo group ID
          this.onDecodedItems(addr, [{ [0xFFFE]: idMap }]);
        } catch (e2) {
          this.dlog('Fallback float parse failed:', e2?.message || e2);
        }
      }
    }
  }

  async onDecodedItems(addr, items) {
    const addrHex = hexAddr(addr);
    await this.ensureMappingFor(addr);
    const map = this.idToPath.get(addr);

    if (!this.snap.nodes[addrHex]) {
      this.snap.nodes[addrHex] = { ts: Date.now(), lastCount: 0, groups: {}, flat: {} };
    }
    const nodeEntry = this.snap.nodes[addrHex];

    function toPlainObject(m) {
      if (m instanceof Map) {
        const o = {};
        for (const [k, v] of m.entries()) o[k] = v;
        return o;
      }
      return (typeof m === 'object' && m !== null) ? m : {};
    }

    let updated = false;

    const flushRecord = (parentId, index, idMap) => {
      const parentHex = `0x${parentId.toString(16).toUpperCase().padStart(2, '0')}`;
      const groupKey = `${parentHex}[${index}]`;
      if (!nodeEntry.groups[groupKey]) nodeEntry.groups[groupKey] = {};
      const inner = toPlainObject(idMap);
      for (const [idStr, rawVal] of Object.entries(inner)) {
        const idNum = +idStr;
        if (!Number.isFinite(idNum)) continue;
        const idHex = `0x${idNum.toString(16).toUpperCase().padStart(2, '0')}`;
        let valNum = rawVal;
        if (Buffer.isBuffer(rawVal)) {
          const b = Buffer.from(rawVal);
          if (b.length === 4) valNum = b.readFloatBE(0);
          else if (b.length === 8) { try { valNum = b.readDoubleBE(0); } catch { valNum = null; }
          }
        }
        nodeEntry.groups[groupKey][idHex] = valNum;
        const parentPath = map.get(parentId);
        const fieldPath = map.get(idNum);
        if (parentPath && fieldPath) {
          // Use parent path with index decoration, then full field path last segment
          const leaf = fieldPath.includes('/') ? fieldPath.split('/').pop() : fieldPath;
          nodeEntry.flat[`${parentPath}[${index}]/${leaf}`] = valNum;
          this.dlog(`Record flush ${parentHex}[${index}] ${idHex} (${parentPath}/${leaf}) =`, valNum);
        } else if (fieldPath) {
          nodeEntry.flat[`${parentHex}[${index}]/${fieldPath}`] = valNum;
          this.dlog(`Record flush ${parentHex}[${index}] ${idHex} (${fieldPath}) =`, valNum);
        } else {
          nodeEntry.flat[`${parentHex}[${index}]/${idHex}`] = valNum;
          this.dlog(`Record flush ${parentHex}[${index}] ${idHex} =`, valNum);
        }
        updated = true;
      }
    };

    const flushGroupMap = (groupId, idMap) => {
      const groupHex = `0x${groupId.toString(16).toUpperCase().padStart(2, '0')}`;
      if (!nodeEntry.groups[groupHex]) nodeEntry.groups[groupHex] = {};
      const inner = toPlainObject(idMap);
      for (const [idStr, rawVal] of Object.entries(inner)) {
        const idNum = +idStr;
        if (!Number.isFinite(idNum)) continue;
        const idHex = `0x${idNum.toString(16).toUpperCase().padStart(2, '0')}`;
        let valNum = rawVal;
        if (Buffer.isBuffer(rawVal)) {
          const b = Buffer.from(rawVal);
          if (b.length === 4) valNum = b.readFloatBE(0);
          else if (b.length === 8) { try { valNum = b.readDoubleBE(0); } catch { valNum = null; }
          }
        }
        nodeEntry.groups[groupHex][idHex] = valNum;
        const p = map.get(idNum);
        if (p) nodeEntry.flat[p] = valNum;
        else nodeEntry.flat[idHex] = valNum;
        this.dlog(`Group ${groupHex} ${idHex}${p ? ` (${p})` : ''} =`, valNum);
        updated = true;
      }
    };

    let pendingScalar = null; // allow pattern: <groupId:int> followed by <map>
    for (const it of items) {
      // Special handling for single-frame report with explicit itemId
      if (it && typeof it === 'object' && Object.prototype.hasOwnProperty.call(it, '__singleId')) {
        const itemId = it.__singleId | 0;
        const value = it.__value;
        const groupId = 0xFFFF; // pseudo-group for SF reports
        const idMap = { [itemId]: value };
        this.dlog(`SF decoded ${hexAddr(addr)} item=0x${itemId.toString(16).toUpperCase().padStart(2, '0')} ->`, value);
        flushGroupMap(groupId, idMap);
        continue;
      }

      // If this item is an array [parentId, index], mark pending record for addr
      if (Array.isArray(it) && it.length === 2 && Number.isInteger(it[0]) && Number.isInteger(it[1])) {
        this.pendingRecord.set(addr, { parentId: it[0] | 0, index: it[1] | 0 });
        this.dlog(`Record header ${hexAddr(addr)} parent=0x${(it[0]>>>0).toString(16).toUpperCase().padStart(2,'0')} index=${it[1]}`);
        continue;
      }

      // If a record header is pending and this item is a map, associate and flush
      if (this.pendingRecord.has(addr) && (it instanceof Map || (it && typeof it === 'object' && !Array.isArray(it)))) {
        const { parentId, index } = this.pendingRecord.get(addr);
        this.pendingRecord.delete(addr);
        flushRecord(parentId, index, it);
        continue;
      }

      // Support pattern: <groupId:int> then <map { id: val, ... }>
      if (Number.isInteger(it)) {
        pendingScalar = it | 0;
        continue;
      }
      if (pendingScalar != null && (it instanceof Map || (it && typeof it === 'object' && !Array.isArray(it)))) {
        const groupId = pendingScalar;
        pendingScalar = null;
        flushGroupMap(groupId, it);
        continue;
      }

      // Default/legacy: map of { groupId: { id: value } }
      const top = toPlainObject(it);
      for (const [kStr, v] of Object.entries(top)) {
        const groupId = +kStr;
        if (!Number.isFinite(groupId)) continue;
        flushGroupMap(groupId, v);
      }
    }

    if (updated) {
      nodeEntry.ts = Date.now();
      nodeEntry.lastCount += 1;
    }
  }
}

module.exports = {
  CanBroadcastAggregator,
};
