// Translation of python/ts_can_utils.py
// ISO-TP receive helper and CAN ID builder for ThingSet over CAN

'use strict';

function makeCanId(targetAddr, sourceAddr) {
  // ThingSet type 0x0 (request/response) ID layout per spec:
  // Bits 28..26: priority = 0x6
  // Bits 25..24: type = 0x0
  // Bits 23..20: target bus = 0x0 (single bus)
  // Bits 19..16: source bus = 0x0 (single bus)
  // Bits 15..8:  target address
  // Bits 7..0:   source address
  const priority = 0x6 << 26;
  const type = 0x0 << 24;
  const buses = 0x00 << 16; // both bus numbers 0
  return (priority | type | buses | ((targetAddr & 0xff) << 8) | (sourceAddr & 0xff)) >>> 0;
}

async function sendFlowControl(bus, ourAddr, nodeAddr, blockSize = 0x00, stmin = 0x00) {
  const id = makeCanId(nodeAddr, ourAddr); // dst=node, src=us
  const data = Buffer.from([0x30, blockSize & 0xff, stmin & 0xff, 0, 0, 0, 0, 0]);
  await bus.send({ arbitration_id: id, data, is_extended_id: true });
}

// Reassemble ISO-TP response from a node.
// Returns full ThingSet payload bytes: [status][nodeid/null][CBOR...]
async function recvIsoTpResponse(bus, srcAddr, dstAddr, frameTimeoutMs = 250, overallTimeoutMs = 2000) {
  const respId = makeCanId(dstAddr, srcAddr);

  // Drain until we get the expected FF/SF for this responder
  const deadline = Date.now() + overallTimeoutMs;
  let first = null;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const msg = await bus.recv(remaining, (m) => m.arbitration_id === respId);
    if (!msg) break;
    first = msg;
    break;
  }
  if (!first) return null;

  const d = first.data.slice(0, first.dlc);
  const pci = d[0] & 0xf0;

  // Single Frame
  if (pci === 0x00) {
    const length = d[0] & 0x0f;
    return Buffer.from(d.slice(1, 1 + length));
  }

  // First Frame
  if (pci === 0x10) {
    const totalLen = ((d[0] & 0x0f) << 8) | d[1];
    const buffer = Buffer.from(d.slice(2));
    let acc = Buffer.from(buffer);

    // Unlimited flow: BS=0, STmin=0
    await sendFlowControl(bus, dstAddr, srcAddr, 0x00, 0x00);

    const deadline = Date.now() + overallTimeoutMs;
    let expectedSeq = 1;
    let poked = false;

    while (acc.length < totalLen && Date.now() < deadline) {
      const frame = await bus.recv(frameTimeoutMs, (m) => m.arbitration_id === respId);
      if (!frame) {
        // Poke once with another FC if stalled
        if (!poked) {
          await sendFlowControl(bus, dstAddr, srcAddr, 0x00, 0x00);
          poked = true;
        }
        continue;
      }
      const cf = frame.data.slice(0, frame.dlc);
      if ((cf[0] & 0xf0) !== 0x20) continue;

      // Resync on seq mismatch rather than abort
      const gotSeq = cf[0] & 0x0f;
      if (gotSeq !== (expectedSeq & 0x0f)) {
        expectedSeq = gotSeq;
      }
      acc = Buffer.concat([acc, cf.slice(1)]);
      expectedSeq += 1;
    }

    return acc.slice(0, totalLen);
  }

  return null;
}

module.exports = {
  makeCanId,
  sendFlowControl,
  recvIsoTpResponse,
};
