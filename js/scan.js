// Translation of python/scan.py
// Scans CAN bus for ThingSet nodes by requesting pNodeID via SF request

'use strict';

const fs = require('fs');
const path = require('path');
const cbor = require('cbor');
const { createBus } = require('./can_adapter');
const { makeCanId, recvIsoTpResponse } = require('./ts_can_utils');

const foundNodes = {};
const FF_TIMEOUT_QUICK = 20; // ms overall for FF+CFs (match Python)
const FRAME_TIMEOUT = 30;    // ms (CF-to-CF)

async function scanNodes(channel = 'can0') {
  const bus = await createBus({ channel });
  // Build GET pNodeID request (binary): [0x01, 0x18, 0x1D]
  const payload = Buffer.from([0x01, 0x18, 0x1D]);
  const isotpSF = Buffer.concat([Buffer.from([payload.length & 0x0F]), payload]);

  console.log('🔍 Scanning CAN bus for ThingSet nodes...');
  try {
    for (let addr = 1; addr < 0xFE; addr++) {
      const reqId = makeCanId(addr, 0xEF);
      await bus.send({ arbitration_id: reqId, data: isotpSF, is_extended_id: true });

      const resp = await recvIsoTpResponse(bus, addr, 0xEF, FRAME_TIMEOUT, FF_TIMEOUT_QUICK);
      if (resp) {
        const status = resp[0];
        const pl = resp.slice(2);
        if (status === 0x85) {
          try {
            const val = cbor.decodeFirstSync(pl);
            console.log(`✅ Node ${addr.toString(16).toUpperCase().padStart(2, '0')} pNodeID = ${val}`);
            foundNodes[addr] = val;
          } catch (e) {
            console.log(`⚠️ Node ${addr.toString(16).toUpperCase().padStart(2, '0')} decode failed: ${e}, raw=${pl.toString('hex')}`);
          }
        } else {
          console.log(`⚠️ Node ${addr.toString(16).toUpperCase().padStart(2, '0')} replied with status 0x${status.toString(16)}`);
        }
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    const outDir = path.join(process.cwd(), 'thingset');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, 'nodes.json');
    fs.writeFileSync(outPath, JSON.stringify(foundNodes, null, 2), 'utf8');
    console.log(`✅ Nodes saved to ${path.relative(process.cwd(), outPath)}`);
  } finally {
    await bus.shutdown();
    console.log('✅ Scan complete.');
  }
}

if (require.main === module) {
  scanNodes().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { scanNodes };
