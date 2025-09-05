// Translation of python/query_nodes.py
// Recursive ThingSet tree explorer using numeric endpoints, with optional path name resolution.

'use strict';

const fs = require('fs');
const path = require('path');
const cbor = require('cbor');
const { createBus } = require('./can_adapter');
const { makeCanId, recvIsoTpResponse } = require('./ts_can_utils');

const ECU_ADDR = 0xEF;
const INCLUDE_PATHS = true;
const PATHS_BATCH = 1; // ensure SF requests (<=7 bytes)

async function sendSF(bus, targetAddr, payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (buf.length > 7) throw new Error(`SF payload too large (${buf.length}B)`);
  const sf = Buffer.concat([Buffer.from([buf.length & 0x0F]), buf]);
  const id = makeCanId(targetAddr, ECU_ADDR);
  await bus.send({ arbitration_id: id, data: sf, is_extended_id: true });
}

async function tsFetchIds(bus, nodeAddr, parentId) {
  // 0x05 + CBOR(parentId) + 0xF6 → [child IDs]
  const req = Buffer.concat([Buffer.from([0x05]), cbor.encode(parentId), Buffer.from([0xF6])]);
  await sendSF(bus, nodeAddr, req);
  const resp = await recvIsoTpResponse(bus, nodeAddr, ECU_ADDR, 30, 3000);
  if (!resp || resp.length < 3 || resp[0] !== 0x85) return [];
  try {
    const out = cbor.decodeFirstSync(resp.slice(2));
    return Array.isArray(out) ? out : [];
  } catch { return []; }
}

async function tsGetById(bus, nodeAddr, objOrParentId) {
  const req = Buffer.concat([Buffer.from([0x01]), cbor.encode(objOrParentId)]);
  await sendSF(bus, nodeAddr, req);
  const resp = await recvIsoTpResponse(bus, nodeAddr, ECU_ADDR, 30, 3000);
  if (!resp || resp.length < 3 || resp[0] !== 0x85) return null;
  try { return cbor.decodeFirstSync(resp.slice(2)); } catch { return null; }
}

async function tsGetRecord(bus, nodeAddr, parentId, index) {
  const req = Buffer.concat([Buffer.from([0x01]), cbor.encode([parentId, index])]);
  if (req.length > 7) return null;
  await sendSF(bus, nodeAddr, req);
  const resp = await recvIsoTpResponse(bus, nodeAddr, ECU_ADDR, 30, 3000);
  if (!resp || resp.length < 3 || resp[0] !== 0x85) return null;
  try {
    const val = cbor.decodeFirstSync(resp.slice(2));
    return (val && typeof val === 'object' && !Array.isArray(val)) ? val : null;
  } catch { return null; }
}

async function tsPathsForIds(bus, nodeAddr, ids) {
  const results = new Array(ids.length).fill(null);
  let i = 0;
  while (i < ids.length) {
    let bestN = 0;
    let bestPayload = null;
    const maxTry = Math.min(Math.max(1, PATHS_BATCH), ids.length - i);
    for (let n = 1; n <= maxTry; n++) {
      const candidate = ids.slice(i, i + n);
      const payload = Buffer.concat([Buffer.from([0x05]), cbor.encode(0x17), cbor.encode(candidate)]);
      if (payload.length <= 7) { bestN = n; bestPayload = payload; } else { break; }
    }
    if (bestN === 0) { i += 1; continue; }
    await sendSF(bus, nodeAddr, bestPayload);
    const resp = await recvIsoTpResponse(bus, nodeAddr, ECU_ADDR, 30, 3000);
    if (resp && resp.length >= 3 && resp[0] === 0x85) {
      try {
        const arr = cbor.decodeFirstSync(resp.slice(2));
        for (let k = 0; k < arr.length; k++) results[i + k] = (typeof arr[k] === 'string') ? arr[k] : null;
      } catch { /* ignore */ }
    }
    i += bestN;
  }
  return results;
}

function sanitize(obj) {
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const kk = Number.isInteger(+k) && String(+k) === k ? `0x${(+k).toString(16).toUpperCase().padStart(2,'0')}` : String(k);
      out[kk] = sanitize(v);
    }
    return out;
  }
  if (obj == null) return null;
  if (Buffer.isBuffer(obj) || obj instanceof Uint8Array) return Buffer.from(obj).toString('hex');
  return obj;
}

function lastSegment(p) { if (!p) return null; return p.includes('/') ? p.split('/').pop() : p; }

function uniqueKey(preferred, used, idHex) {
  if (!used.has(preferred)) { used.add(preferred); return preferred; }
  const alt = `${preferred} (${idHex})`;
  used.add(alt);
  return alt;
}

async function renameIdKeysWithPaths(bus, nodeAddr, idMap) {
  const out = {};
  const used = new Set();
  const ids = Object.keys(idMap).map((k) => +k).filter((n) => Number.isFinite(n));
  const nameById = {};
  for (let i = 0; i < ids.length; i += PATHS_BATCH) {
    const batch = ids.slice(i, i + PATHS_BATCH);
    const paths = await tsPathsForIds(bus, nodeAddr, batch);
    for (let j = 0; j < batch.length; j++) nameById[batch[j]] = lastSegment(paths[j]);
  }
  for (const [kStr, v] of Object.entries(idMap)) {
    const k = +kStr;
    let key;
    if (Number.isFinite(k)) {
      const name = nameById[k];
      if (name) key = uniqueKey(name, used, `0x${k.toString(16).toUpperCase().padStart(2,'0')}`);
      else key = uniqueKey(`0x${k.toString(16).toUpperCase().padStart(2,'0')}`, used, `0x${k.toString(16).toUpperCase().padStart(2,'0')}`);
    } else {
      key = uniqueKey(String(kStr), used, String(kStr));
    }
    out[key] = sanitize(v);
  }
  return out;
}

async function exploreId(bus, nodeAddr, objId, depth = 0, maxDepth = 16) {
  const node = { id: `0x${objId.toString(16).toUpperCase().padStart(2, '0')}` };

  if (INCLUDE_PATHS && objId !== 0x00) {
    const p = (await tsPathsForIds(bus, nodeAddr, [objId]))[0];
    if (p) node.path = p;
  }

  if (depth >= maxDepth) { node.note = `max_depth ${maxDepth} reached`; return node; }

  const childrenIds = await tsFetchIds(bus, nodeAddr, objId);
  if (!childrenIds || childrenIds.length === 0) {
    const val = await tsGetById(bus, nodeAddr, objId);
    node.value = sanitize(val);
    return node;
  }

  const groupMapOrCount = await tsGetById(bus, nodeAddr, objId);
  if (groupMapOrCount && typeof groupMapOrCount === 'object' && !Array.isArray(groupMapOrCount)) {
    node.values = await renameIdKeysWithPaths(bus, nodeAddr, groupMapOrCount);
  } else if (Number.isInteger(groupMapOrCount)) {
    const count = groupMapOrCount;
    const records = [];
    for (let i = 0; i < count; i++) {
      const rec = await tsGetRecord(bus, nodeAddr, objId, i);
      if (rec && typeof rec === 'object') records.push(await renameIdKeysWithPaths(bus, nodeAddr, rec));
      else records.push({ error: 'record read failed' });
    }
    node.records = records;
  } else if (groupMapOrCount != null) {
    node.values = sanitize(groupMapOrCount);
  }

  const kids = {};
  const kidPaths = {};
  if (INCLUDE_PATHS && childrenIds.length) {
    for (let i = 0; i < childrenIds.length; i += PATHS_BATCH) {
      const batch = childrenIds.slice(i, i + PATHS_BATCH);
      const paths = await tsPathsForIds(bus, nodeAddr, batch);
      for (let j = 0; j < batch.length; j++) kidPaths[batch[j]] = paths[j];
    }
  }
  const usedKeys = new Set();
  for (const cid of childrenIds) {
    const childNode = await exploreId(bus, nodeAddr, cid, depth + 1, maxDepth);
    const name = INCLUDE_PATHS ? lastSegment(kidPaths[cid]) : null;
    const idHex = `0x${cid.toString(16).toUpperCase().padStart(2, '0')}`;
    const key = uniqueKey(name || idHex, usedKeys, idHex);
    if (INCLUDE_PATHS && !childNode.path && kidPaths[cid]) childNode.path = kidPaths[cid];
    kids[key] = childNode;
  }
  node.children = kids;
  return node;
}

async function main() {
  const nodesPath = path.join(process.cwd(), 'nodes.json');
  const nodes = JSON.parse(fs.readFileSync(nodesPath, 'utf8'));
  const outDir = path.join(process.cwd(), 'trees');
  fs.mkdirSync(outDir, { recursive: true });

  const bus = await createBus({ channel: 'can0' });
  try {
    for (const [addrStr, nodeUid] of Object.entries(nodes)) {
      const addr = parseInt(addrStr, 10);
      console.log(`\n🔎 Building tree for node 0x${addr.toString(16).toUpperCase().padStart(2, '0')} (${nodeUid})`);
      const tree = {
        node_uid: nodeUid,
        address: `0x${addr.toString(16).toUpperCase().padStart(2, '0')}`,
        root: await exploreId(bus, addr, 0x00, 0, 16),
      };
      const out = path.join(outDir, `node_${addr.toString(16).toUpperCase().padStart(2, '0')}_tree.json`);
      fs.writeFileSync(out, JSON.stringify(tree, null, 2), 'utf8');
      console.log(`✅ Saved to ${out}`);
    }
  } finally {
    await bus.shutdown();
    console.log('✅ Exploration complete.');
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  exploreId,
};

