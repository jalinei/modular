import can
import cbor2
import time
import json

from ts_can_utils import make_can_id, recv_isotp_response

found_nodes = {}
FF_TIMEOUT_QUICK = 0.02   # 20 ms
FRAME_TIMEOUT    = 0.03  # CF-to-CF
FF_TIMEOUT_RETRY = 0.5   # only if you retry on partial/garbled

def scan_nodes(channel="can0"):
    bus = can.interface.Bus(channel=channel, interface="socketcan")

    # Build GET pNodeID request (binary)
    payload = bytes([0x01, 0x18, 0x1D])
    isotp_frame = bytes([len(payload)]) + payload   # SF ISO-TP

    print("🔍 Scanning CAN bus for ThingSet nodes...")
    for addr in range(1, 0xFE):
        req_id = make_can_id(addr, 0xEF)
        msg = can.Message(arbitration_id=req_id,
                          data=isotp_frame,
                          is_extended_id=True)
        bus.send(msg)

        resp = recv_isotp_response(bus, src_addr=addr, dst_addr=0xEF,frame_timeout= FRAME_TIMEOUT, overall_timeout=FF_TIMEOUT_QUICK)
        if resp:
            status = resp[0]
            payload = resp[2:]
            if status == 0x85:  # Content
                try:
                    val = cbor2.loads(bytes(payload))
                    print(f"✅ Node {addr:02X} pNodeID = {val}")
                    found_nodes[addr] = val
                except Exception as e:
                    print(f"⚠️ Node {addr:02X} decode failed: {e}, raw={payload.hex()}")
            else:
                print(f"⚠️ Node {addr:02X} replied with status {hex(status)}")

        time.sleep(0.01)

    with open("nodes.json", "w") as f:
        json.dump(found_nodes, f, indent=2)
    print("✅ Nodes saved to nodes.json")

    bus.shutdown()
    print("✅ Scan complete.")

if __name__ == "__main__":
    scan_nodes()
