// Translation of python/test_ts_bin.py
// Simple usage of ThingSetCAN over SocketCAN

'use strict';

const { createBus } = require('./can_adapter');
const { ThingSetCAN } = require('./thingset_bin');

async function main() {
  const bus = await createBus({ channel: 'can0' });
  const ts = new ThingSetCAN(bus, 0xEF);
  try {
    // 1) Discover root children by NAMES (path mode)
    let resp = await ts.fetch(0x01, '', null);
    console.log(resp.status_hex, resp.status_text, resp.node_id, resp.payload);

    // 2) GET a whole group by name (path mode)
    resp = await ts.get(0x01, 'Measurements');
    console.log('GET Measurements:', resp.status_hex, resp.status_text);
    if (resp.ok()) console.log('Measurements map:', resp.payload);

    // 3) GET by numeric id (fast)
    resp = await ts.get(0x01, 0x05);
    console.log('GET 0x05:', resp.status_hex, resp.status_text);
    console.log(resp.payload);

    // 4) Map a couple IDs to paths
    resp = await ts.paths_for_ids(0x01, [0x50, 0x51]);
    console.log('Paths for [0x50,0x51]:', resp.status_hex, resp.status_text);
    console.log(resp.payload);

    // 5) EXEC a function with args (use one that exists on your device)
    resp = await ts.exec(0x01, 0x42, []);
    console.log('EXEC 0x42 (Config/xIdle):', resp.status_hex, resp.status_text);
  } finally {
    await bus.shutdown();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

