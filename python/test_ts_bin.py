#!/usr/bin/env python3
import can
from thingset_bin import ThingSetCAN

bus = can.interface.Bus(channel="can0", interface="socketcan")
ts  = ThingSetCAN(bus, source_addr=0xEF)

try:
    # 1) Discover root children by NAMES (path mode)
    resp = ts.fetch(target_addr=0x01, endpoint="", items=None)  # FETCH "" + null
    print(resp.status_hex, resp.status_text, resp.node_id, resp.payload)  # payload is list of names

    # 2) GET a whole group by name (path mode)
    resp = ts.get(0x01, "Measurements")
    print("GET Measurements:", resp.status_hex, resp.status_text)
    if resp.ok():
        print("Measurements map:", resp.payload)

    # 3) GET by numeric id (fast)
    resp = ts.get(0x01, 0x05)  # same as "Measurements"
    print("GET 0x05:", resp.status_hex, resp.status_text)
    print(resp.payload)

    # 4) Map a couple IDs to paths
    resp = ts.paths_for_ids(0x01, [0x50, 0x51])
    print("Paths for [0x50,0x51]:", resp.status_hex, resp.status_text)
    print(resp.payload)  # ["Measurements/rV1Low_V", "Measurements/rV2Low_V"]

    # 5) EXEC a function with args (use one that exists on your device)
    #    You have Config/xIdle (0x42), which takes no args.
    resp = ts.exec(0x01, 0x42, args=[])
    print("EXEC 0x42 (Config/xIdle):", resp.status_hex, resp.status_text)

finally:
    bus.shutdown()
