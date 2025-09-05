import time
import can

def make_can_id(target_addr, source_addr):
    priority = 0x6 << 26
    frame_type = 0x0 << 24
    return priority | frame_type | (target_addr << 8) | source_addr

def send_flow_control(bus, our_addr, node_addr, block_size=0x00, stmin=0x00):
    """
    Send ISO-TP Flow Control (CTS).
    - block_size=0x00 → unlimited CFs
    - stmin=0x00 → 0 ms separation time
    """
    fc = can.Message(
        arbitration_id=make_can_id(node_addr, our_addr),  # dst=node, src=us
        data=[0x30, block_size, stmin, 0x00, 0x00, 0x00, 0x00, 0x00],
        is_extended_id=True,
    )
    bus.send(fc)

def recv_isotp_response(bus, src_addr, dst_addr, frame_timeout=0.25, overall_timeout=2.0):
    """
    Reassemble ISO-TP response from a node.
    Returns full ThingSet payload: [status][nodeid/null][CBOR...]
    """
    resp_id = make_can_id(dst_addr, src_addr)

    first = bus.recv(timeout=overall_timeout)
    if not first or first.arbitration_id != resp_id:
        return None

    d = first.data[:first.dlc]
    pci = d[0] & 0xF0

    # Single Frame
    if pci == 0x00:
        length = d[0] & 0x0F
        return d[1:1+length]

    # First Frame
    if pci == 0x10:
        total_len = ((d[0] & 0x0F) << 8) | d[1]
        buffer = bytearray(d[2:])  # includes status + nodeid/null + start of CBOR

        # ✅ Unlimited flow: BS=0, STmin=0
        send_flow_control(bus, dst_addr, src_addr, block_size=0x00, stmin=0x00)

        deadline = time.monotonic() + overall_timeout
        expected_seq = 1
        poked = False

        while len(buffer) < total_len and time.monotonic() < deadline:
            frame = bus.recv(timeout=frame_timeout)
            if frame is None:
                # Optional: if we stall, poke once with another FC
                if not poked:
                    send_flow_control(bus, dst_addr, src_addr, block_size=0x00, stmin=0x00)
                    poked = True
                continue

            if frame.arbitration_id != resp_id:
                continue

            cf = frame.data[:frame.dlc]
            if (cf[0] & 0xF0) != 0x20:
                continue

            # Don’t hard-abort on seq mismatch; resync
            got_seq = cf[0] & 0x0F
            if got_seq != (expected_seq & 0x0F):
                expected_seq = got_seq
            buffer += cf[1:]
            expected_seq += 1

        if len(buffer) < total_len:
            print(f"⚠️ Incomplete ISO-TP: got {len(buffer)}/{total_len} bytes")

        return bytes(buffer[:total_len])

    return None
