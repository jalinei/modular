# thingset_bin.py
# Binary ThingSet protocol over CAN with ISO-TP TX/RX (single- and multi-frame).
# Requires: python-can, cbor2

from __future__ import annotations
import time
from io import BytesIO
from typing import Any, Iterable, List, Optional, Tuple, Union

import can
import cbor2


# ---------- Human-friendly status names ----------
# NOTE: These include common codes shown in your spec/examples.
# 0xA0 is a synthetic "timeout/no response" we return client-side.
STATUS_TEXT = {
    0x80: "OK",
    0x81: "Created",
    0x82: "Deleted",
    0x84: "Changed",
    0x85: "Content",
    0xA3: "Forbidden",
    0xA4: "Not Found",
    0xAF: "Unsupported Type",
    0xA0: "No Response (timeout)",  # synthetic
}

# ---------- CAN / ISO-TP basics ----------

def make_can_id(target_addr: int, source_addr: int) -> int:
    """ThingSet Request/Response 29-bit ID (Priority 6, Type 0)."""
    priority = 0x6 << 26
    frame_type = 0x0 << 24
    return priority | frame_type | ((target_addr & 0xFF) << 8) | (source_addr & 0xFF)

# ISO-TP PCI types
_SF = 0x00
_FF = 0x10
_CF = 0x20
_FC = 0x30

def _stmin_to_seconds(stmin_byte: int) -> float:
    """ISO-TP STmin conversion: 0x00..0x7F = ms, 0xF1..0xF9 = 100..900us."""
    if 0x00 <= stmin_byte <= 0x7F:
        return stmin_byte / 1000.0
    if 0xF1 <= stmin_byte <= 0xF9:
        return (stmin_byte - 0xF0) / 10000.0
    return 0.0  # reserved values → treat as 0

# ---------- ThingSet opcodes ----------
GET    = 0x01
EXEC   = 0x02
DELETE = 0x04
FETCH  = 0x05
CREATE = 0x06
UPDATE = 0x07

# ---------- Endpoint encoding ----------
Endpoint = Union[str, int, Tuple[int, int]]  # path, id, or (parent_id, index)

def _encode_endpoint(ep: Endpoint) -> bytes:
    if isinstance(ep, str):
        return cbor2.dumps(ep)
    if isinstance(ep, int):
        return cbor2.dumps(ep)
    if isinstance(ep, tuple) and len(ep) == 2 and all(isinstance(x, int) for x in ep):
        return cbor2.dumps([ep[0], ep[1]])
    raise TypeError(f"Unsupported endpoint: {ep!r}")

class ThingSetResponse:
    def __init__(self, status: int, node_id: Optional[str], payload_bytes: Optional[bytes], payload_decoded: Any):
        self.status = status
        self.status_hex = f"0x{status:02X}"
        self.status_text = STATUS_TEXT.get(status, "Unknown")
        self.node_id = node_id
        self.payload_bytes = payload_bytes
        self.payload = payload_decoded  # decoded CBOR or None

    def ok(self) -> bool:
        # success family seen in your examples: 0x81..0x85
        return self.status in (0x80, 0x81, 0x82, 0x84, 0x85)

    def summary(self) -> str:
        """Compact human-readable summary."""
        return f"{self.status_hex} {self.status_text}"

    def __repr__(self) -> str:
        # helpful when printing the object directly
        base = f"<ThingSetResponse {self.status_hex} {self.status_text}"
        if self.node_id:
            base += f" node_id={self.node_id}"
        if self.payload is not None:
            base += f" payload={type(self.payload).__name__}>"
        else:
            base += " payload=None>"
        return base

def _parse_thingset_response(ts_bytes: bytes) -> ThingSetResponse:
    """
    ThingSet binary response:
      [ status (1B) ] [ CBOR node-id or null ] [ CBOR payload or null ]
    """
    if not ts_bytes:
        return ThingSetResponse(0xA0, None, None, None)

    status = ts_bytes[0]
    bio = BytesIO(ts_bytes[1:])
    dec = cbor2.CBORDecoder(bio)

    try:
        node_id_obj = dec.decode()
    except Exception:
        # Couldn’t parse node-id field; return with what we have
        return ThingSetResponse(status, None, None, None)

    rest = bio.read()
    if not rest:
        return ThingSetResponse(status, node_id_obj, None, None)

    try:
        payload_obj = cbor2.loads(rest)
    except Exception:
        payload_obj = None

    return ThingSetResponse(status, node_id_obj, rest, payload_obj)
    

# ---------- ISO-TP TX (supports multi-frame) ----------

def _isotp_send(bus: can.BusABC,
                src_addr: int,
                dst_addr: int,
                app_payload: bytes,
                fc_wait_timeout: float = 0.5) -> None:
    """
    Send ISO-TP (Single or Multi-frame) from src→dst on ThingSet channel.
    Respects receiver Flow Control (BS, STmin). Raises on FC timeout.
    """
    tx_id = make_can_id(dst_addr, src_addr)
    rx_fc_id = make_can_id(src_addr, dst_addr)  # receiver (node) → us FC

    if len(app_payload) <= 7:
        sf = bytes([len(app_payload)]) + app_payload
        bus.send(can.Message(arbitration_id=tx_id, data=sf, is_extended_id=True))
        return

    # First frame
    total_len = len(app_payload)
    ff_len_hi = (total_len >> 8) & 0x0F
    ff_len_lo = total_len & 0xFF
    first_chunk = app_payload[:6]
    ff = bytes([_FF | ff_len_hi, ff_len_lo]) + first_chunk
    ff += bytes(max(0, 8 - len(ff)))  # pad to 8
    bus.send(can.Message(arbitration_id=tx_id, data=ff, is_extended_id=True))

    # Wait for Flow Control
    start = time.monotonic()
    bs = 0
    stmin_s = 0.0
    while True:
        msg = bus.recv(timeout=fc_wait_timeout)
        if not msg or msg.arbitration_id != rx_fc_id:
            if time.monotonic() - start >= fc_wait_timeout:
                raise TimeoutError("ISO-TP: FC not received")
            continue
        d = msg.data[:msg.dlc]
        if (d[0] & 0xF0) != _FC:
            # Ignore non-FC frames on this chan
            if time.monotonic() - start >= fc_wait_timeout:
                raise TimeoutError("ISO-TP: FC not received")
            continue
        # 0x30 = CTS; 0x31 = Wait; 0x32 = Overflow
        fc_status = d[0] & 0x0F
        if fc_status == 0x2:
            raise RuntimeError("ISO-TP: Receiver overflow")
        if fc_status == 0x1:
            # WAIT: keep waiting, refresh deadline
            start = time.monotonic()
            continue
        # CTS
        bs = d[1]
        stmin_s = _stmin_to_seconds(d[2])
        break

    # Send Consecutive Frames honoring BS/STmin
    seq = 1
    sent_in_block = 0
    offset = 6
    while offset < total_len:
        chunk = app_payload[offset: offset + 7]
        pci = _CF | (seq & 0x0F)
        cf = bytes([pci]) + chunk
        cf += bytes(max(0, 8 - len(cf)))
        bus.send(can.Message(arbitration_id=tx_id, data=cf, is_extended_id=True))
        offset += len(chunk)
        seq = (seq + 1) & 0x0F
        sent_in_block += 1

        # STmin pacing
        if stmin_s > 0:
            time.sleep(stmin_s)

        # Block size handling: after BS CFs, expect another FC
        if bs != 0 and sent_in_block >= bs and offset < total_len:
            sent_in_block = 0
            # wait for next FC
            start = time.monotonic()
            while True:
                msg = bus.recv(timeout=fc_wait_timeout)
                if not msg or msg.arbitration_id != rx_fc_id:
                    if time.monotonic() - start >= fc_wait_timeout:
                        raise TimeoutError("ISO-TP: Next FC not received")
                    continue
                d = msg.data[:msg.dlc]
                if (d[0] & 0xF0) != _FC:
                    if time.monotonic() - start >= fc_wait_timeout:
                        raise TimeoutError("ISO-TP: Next FC not received")
                    continue
                fc_status = d[0] & 0x0F
                if fc_status == 0x2:
                    raise RuntimeError("ISO-TP: Receiver overflow")
                if fc_status == 0x1:
                    start = time.monotonic()
                    continue
                bs = d[1]
                stmin_s = _stmin_to_seconds(d[2])
                break

# ---------- ISO-TP RX (supports multi-frame) ----------

def _send_flow_control_cts(bus: can.BusABC, our_addr: int, node_addr: int, bs: int = 0x00, stmin: int = 0x00) -> None:
    """Send Flow Control CTS from receiver (us) → sender (node)."""
    fc_id = make_can_id(node_addr, our_addr)  # dst=node, src=us
    fc = can.Message(arbitration_id=fc_id,
                     data=[_FC, bs & 0xFF, stmin & 0xFF, 0, 0, 0, 0, 0],
                     is_extended_id=True)
    bus.send(fc)

def _isotp_recv(bus: can.BusABC,
                src_addr: int,
                dst_addr: int,
                frame_timeout: float = 0.25,
                overall_timeout: float = 2.0) -> Optional[bytes]:
    """
    Receive ISO-TP (Single or Multi-frame) from node→us on ThingSet channel.
    Returns the **application payload bytes** or None on timeout.
    """
    rx_id = make_can_id(dst_addr, src_addr)
    first = bus.recv(timeout=overall_timeout)
    if not first or first.arbitration_id != rx_id:
        return None
    d = first.data[:first.dlc]
    pci = d[0] & 0xF0

    if pci == _SF:
        length = d[0] & 0x0F
        return d[1:1+length]

    if pci == _FF:
        total_len = ((d[0] & 0x0F) << 8) | d[1]
        buf = bytearray(d[2:])
        # Grant unlimited, no pacing by default
        _send_flow_control_cts(bus, dst_addr, src_addr, bs=0x00, stmin=0x00)
        deadline = time.monotonic() + overall_timeout
        expected_seq = 1
        while len(buf) < total_len and time.monotonic() < deadline:
            frame = bus.recv(timeout=frame_timeout)
            if not frame or frame.arbitration_id != rx_id:
                continue
            cd = frame.data[:frame.dlc]
            if (cd[0] & 0xF0) != _CF:
                continue
            # Don’t crash on a hiccup; resync sequence
            expected_seq = cd[0] & 0x0F
            buf += cd[1:]
        return bytes(buf[:total_len])

    return None

# ---------- High-level ThingSet over CAN ----------

class ThingSetCAN:
    """
    High-level helper to send ThingSet binary requests over CAN with ISO-TP.
    Usage:
        ts = ThingSetCAN(bus, source_addr=0xEF)
        resp = ts.get(0x10, "Measurements")
        if resp.ok(): print(resp.payload)
    """
    def __init__(self, bus: can.BusABC, source_addr: int = 0xEF):
        self.bus = bus
        self.source_addr = source_addr

    # --- core transceive ---
    def transceive(self,
                   target_addr: int,
                   ts_payload: bytes,
                   rx_frame_timeout: float = 0.25,
                   rx_overall_timeout: float = 2.0) -> ThingSetResponse:
        """Send TS payload (handles ISO-TP TX) and read TS response (ISO-TP RX)."""
        _isotp_send(self.bus, self.source_addr, target_addr, ts_payload)
        rx = _isotp_recv(self.bus, src_addr=target_addr, dst_addr=self.source_addr,
                         frame_timeout=rx_frame_timeout, overall_timeout=rx_overall_timeout)
        return _parse_thingset_response(rx or b"")

    # --- convenience request builders ---
    def get(self, target_addr: int, endpoint: Endpoint,
            rx_overall_timeout: float = 2.0) -> ThingSetResponse:
        pdu = bytes([GET]) + _encode_endpoint(endpoint)
        return self.transceive(target_addr, pdu, rx_overall_timeout=rx_overall_timeout)

    def fetch(self, target_addr: int, endpoint: Endpoint, items: Optional[Iterable[Union[str, int]]] = None,
              rx_overall_timeout: float = 2.0) -> ThingSetResponse:
        if items is None:
            pdu = bytes([FETCH]) + _encode_endpoint(endpoint) + bytes([0xF6])  # CBOR null
        else:
            # list of ids or names
            pdu = bytes([FETCH]) + _encode_endpoint(endpoint) + cbor2.dumps(list(items))
        return self.transceive(target_addr, pdu, rx_overall_timeout=rx_overall_timeout)

    def update(self, target_addr: int, endpoint: Endpoint, values_map: dict,
               rx_overall_timeout: float = 2.0) -> ThingSetResponse:
        pdu = bytes([UPDATE]) + _encode_endpoint(endpoint) + cbor2.dumps(values_map)
        return self.transceive(target_addr, pdu, rx_overall_timeout=rx_overall_timeout)

    def create(self, target_addr: int, endpoint: Endpoint, value: Any,
               rx_overall_timeout: float = 2.0) -> ThingSetResponse:
        pdu = bytes([CREATE]) + _encode_endpoint(endpoint) + cbor2.dumps(value)
        return self.transceive(target_addr, pdu, rx_overall_timeout=rx_overall_timeout)

    def delete(self, target_addr: int, endpoint: Endpoint, value: Any,
               rx_overall_timeout: float = 2.0) -> ThingSetResponse:
        pdu = bytes([DELETE]) + _encode_endpoint(endpoint) + cbor2.dumps(value)
        return self.transceive(target_addr, pdu, rx_overall_timeout=rx_overall_timeout)

    def exec(self, target_addr: int, endpoint: Endpoint, args: Optional[Iterable[Any]] = None,
             rx_overall_timeout: float = 2.0) -> ThingSetResponse:
        arr = [] if args is None else list(args)
        pdu = bytes([EXEC]) + _encode_endpoint(endpoint) + cbor2.dumps(arr)
        return self.transceive(target_addr, pdu, rx_overall_timeout=rx_overall_timeout)

    # --- name/id mapping helpers (special endpoints) ---
    def paths_for_ids(self, target_addr: int, ids: Iterable[int],
                      rx_overall_timeout: float = 2.0) -> ThingSetResponse:
        """FETCH _Paths (0x17) for a list of IDs → array of path strings."""
        pdu = bytes([FETCH]) + cbor2.dumps(0x17) + cbor2.dumps(list(ids))
        return self.transceive(target_addr, pdu, rx_overall_timeout=rx_overall_timeout)

    def ids_for_paths(self, target_addr: int, paths: Iterable[str],
                      rx_overall_timeout: float = 2.0) -> ThingSetResponse:
        """FETCH _Ids (0x16) for a list of path strings → array of IDs."""
        pdu = bytes([FETCH]) + cbor2.dumps(0x16) + cbor2.dumps(list(paths))
        return self.transceive(target_addr, pdu, rx_overall_timeout=rx_overall_timeout)
