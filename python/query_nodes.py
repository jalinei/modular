#!/usr/bin/env python3
import os
import json
from typing import Any, Dict, List, Optional, Tuple

import can
import cbor2

from ts_can_utils import make_can_id, recv_isotp_response  # robust ISO-TP RX (BS=0 etc.)

ECU_ADDR = 0xEF          # our CAN source address
INCLUDE_PATHS = True     # keep True to resolve names
PATHS_BATCH = 1          # keep requests ≤ 7B (1 ID per _Paths call is always safe)

# -------------------- low-level: single-frame ThingSet request sender --------------------

def send_sf(bus: can.BusABC, target_addr: int, payload: bytes) -> None:
    """Send a Single-Frame ISO-TP request with ThingSet payload (<= 7 bytes)."""
    if len(payload) > 7:
        raise ValueError(f"SF payload too large ({len(payload)}B): {payload.hex()}")
    sf = bytes([len(payload)]) + payload
    msg = can.Message(
        arbitration_id=make_can_id(target_addr, ECU_ADDR),
        data=sf,
        is_extended_id=True,
    )
    bus.send(msg)

# -------------------- ThingSet helpers using NUMERIC endpoints --------------------

def ts_fetch_ids(bus: can.BusABC, node_addr: int, parent_id: int) -> List[int]:
    """FETCH discovery with numeric endpoint: 0x05 + CBOR(uint parent_id) + 0xF6 → [child IDs]."""
    req = bytes([0x05]) + cbor2.dumps(parent_id) + bytes([0xF6])
    send_sf(bus, node_addr, req)
    resp = recv_isotp_response(bus, src_addr=node_addr, dst_addr=ECU_ADDR, overall_timeout=3.0)
    if not resp or len(resp) < 3 or resp[0] != 0x85:
        return []
    try:
        out = cbor2.loads(resp[2:])
        return out if isinstance(out, list) else []
    except Exception:
        return []

def ts_get_by_id(bus: can.BusABC, node_addr: int, obj_or_parent_id: int) -> Any:
    """GET with numeric endpoint → dict (group), int (record count), scalar (leaf), or None."""
    req = bytes([0x01]) + cbor2.dumps(obj_or_parent_id)
    send_sf(bus, node_addr, req)
    resp = recv_isotp_response(bus, src_addr=node_addr, dst_addr=ECU_ADDR, overall_timeout=3.0)
    if not resp or len(resp) < 3 or resp[0] != 0x85:
        return None
    try:
        return cbor2.loads(resp[2:])
    except Exception:
        return None

def ts_get_record(bus: can.BusABC, node_addr: int, parent_id: int, index: int) -> Optional[Dict[int, Any]]:
    """GET a record by [parent_id, index] → map {item_id: value}."""
    req = bytes([0x01]) + cbor2.dumps([parent_id, index])
    if len(req) > 7:
        return None  # keep TX single-frame only
    send_sf(bus, node_addr, req)
    resp = recv_isotp_response(bus, src_addr=node_addr, dst_addr=ECU_ADDR, overall_timeout=3.0)
    if not resp or len(resp) < 3 or resp[0] != 0x85:
        return None
    try:
        val = cbor2.loads(resp[2:])
        return val if isinstance(val, dict) else None
    except Exception:
        return None

def ts_paths_for_ids(bus: can.BusABC, node_addr: int, ids: List[int]) -> List[Optional[str]]:
    """
    Map IDs → paths via _Paths (0x17) using FETCH.
    Dynamically batches so each ISO-TP request stays ≤ 7 bytes.
    """
    results: List[Optional[str]] = [None] * len(ids)
    i = 0
    while i < len(ids):
        # Try to pack as many as fit (≤7B)
        best_n = 0
        best_payload = None
        max_try = max(1, PATHS_BATCH)
        max_try = min(max_try, len(ids) - i)
        for n in range(1, max_try + 1):
            candidate = ids[i:i+n]
            payload = bytes([0x05]) + cbor2.dumps(0x17) + cbor2.dumps(candidate)
            if len(payload) <= 7:
                best_n = n
                best_payload = payload
            else:
                break
        if best_n == 0:
            # Single ID didn’t fit (unlikely for 16-bit). Skip gracefully.
            i += 1
            continue

        send_sf(bus, node_addr, best_payload)  # type: ignore[arg-type]
        resp = recv_isotp_response(bus, src_addr=node_addr, dst_addr=ECU_ADDR, overall_timeout=3.0)
        if resp and len(resp) >= 3 and resp[0] == 0x85:
            try:
                arr = cbor2.loads(resp[2:])
                for k, p in enumerate(arr):
                    results[i+k] = p if isinstance(p, str) else None
            except Exception:
                pass

        i += best_n

    return results

def ts_path_for_id(bus: can.BusABC, node_addr: int, obj_id: int) -> Optional[str]:
    out = ts_paths_for_ids(bus, node_addr, [obj_id])
    return out[0] if out else None

# -------------------- JSON sanitation --------------------

def sanitize(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {f"0x{k:02X}" if isinstance(k, int) else str(k): sanitize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize(x) for x in obj]
    if isinstance(obj, (str, int, float, bool)) or obj is None:
        return obj
    if isinstance(obj, (bytes, bytearray)):
        return obj.hex()
    return str(obj)

# -------------------- naming helpers --------------------

def last_segment(path: Optional[str]) -> Optional[str]:
    if not path:
        return None
    return path.split("/")[-1] if "/" in path else path

def unique_key(preferred: str, used: set, id_hex: str) -> str:
    """Avoid key collisions by suffixing the ID if needed."""
    if preferred not in used:
        used.add(preferred)
        return preferred
    alt = f"{preferred} ({id_hex})"
    used.add(alt)
    return alt

def rename_id_keys_with_paths(
    bus: can.BusABC,
    node_addr: int,
    id_map: Dict[int, Any],
) -> Dict[str, Any]:
    """
    Convert a dict keyed by IDs into a dict keyed by NAMES (last path segment),
    falling back to hex IDs on misses. Values are sanitized for JSON.
    """
    out: Dict[str, Any] = {}
    used: set = set()
    ids = [k for k in id_map.keys() if isinstance(k, int)]
    # Resolve paths in small batches
    name_by_id: Dict[int, Optional[str]] = {}
    for i in range(0, len(ids), PATHS_BATCH):
        batch = ids[i:i+PATHS_BATCH]
        paths = ts_paths_for_ids(bus, node_addr, batch)
        for cid, p in zip(batch, paths):
            name_by_id[cid] = last_segment(p)

    for k, v in id_map.items():
        if isinstance(k, int):
            name = name_by_id.get(k)
            if name:
                key = unique_key(name, used, f"0x{k:02X}")
            else:
                key = unique_key(f"0x{k:02X}", used, f"0x{k:02X}")
        else:
            key = unique_key(str(k), used, str(k))
        out[key] = sanitize(v)
    return out

# -------------------- Recursive explorer (ID-first, name-keyed output) --------------------

def explore_id(bus: can.BusABC, node_addr: int, obj_id: int, depth: int = 0, max_depth: int = 16) -> Dict[str, Any]:
    """
    Recursively explore the subtree rooted at obj_id (numeric ThingSet endpoint).
    Output will use NAMES for dict keys whenever available, falling back to hex IDs.
    """
    node: Dict[str, Any] = {"id": f"0x{obj_id:02X}"}

    # Resolve own path (except root 0x00)
    if INCLUDE_PATHS and obj_id != 0x00:
        p = ts_path_for_id(bus, node_addr, obj_id)
        if p:
            node["path"] = p

    if depth >= max_depth:
        node["note"] = f"max_depth {max_depth} reached"
        return node

    # Discover children (as IDs)
    children_ids = ts_fetch_ids(bus, node_addr, obj_id)

    # Leaf item (no children): GET by the item ID
    if not children_ids:
        val = ts_get_by_id(bus, node_addr, obj_id)
        node["value"] = sanitize(val)
        return node

    # Group or records container
    group_map_or_count = ts_get_by_id(bus, node_addr, obj_id)

    # If it's a dict of child values, rename dict keys by names
    if isinstance(group_map_or_count, dict):
        node["values"] = rename_id_keys_with_paths(bus, node_addr, group_map_or_count)
    elif isinstance(group_map_or_count, int):
        # Records container: pull each record as a map (renamed too)
        count = group_map_or_count
        records = []
        for i in range(count):
            rec = ts_get_record(bus, node_addr, obj_id, i)
            if isinstance(rec, dict):
                records.append(rename_id_keys_with_paths(bus, node_addr, rec))
            else:
                records.append({"error": "record read failed"})
        node["records"] = records
    elif group_map_or_count is not None:
        node["values"] = sanitize(group_map_or_count)

    # Recurse into children and build a name-keyed "children" map
    kids: Dict[str, Any] = {}
    kid_paths: Dict[int, Optional[str]] = {}
    if INCLUDE_PATHS and children_ids:
        # Resolve child paths (names) in tiny batches
        for i in range(0, len(children_ids), PATHS_BATCH):
            batch = children_ids[i:i+PATHS_BATCH]
            paths = ts_paths_for_ids(bus, node_addr, batch)
            for cid, p in zip(batch, paths):
                kid_paths[cid] = p

    used_keys: set = set()
    for cid in children_ids:
        child_node = explore_id(bus, node_addr, cid, depth + 1, max_depth)
        # prefer the last segment of the path as the key
        name = last_segment(kid_paths.get(cid)) if INCLUDE_PATHS else None
        id_hex = f"0x{cid:02X}"
        key = unique_key(name if name else id_hex, used_keys, id_hex)
        # ensure child node also carries resolved path if available
        if INCLUDE_PATHS and "path" not in child_node:
            p = kid_paths.get(cid)
            if p:
                child_node["path"] = p
        kids[key] = child_node

    node["children"] = kids
    return node

# -------------------- Main --------------------

def main():
    with open("nodes.json") as f:
        nodes = json.load(f)  # {"129": "<uid>", ...}

    os.makedirs("trees", exist_ok=True)

    bus = can.interface.Bus(channel="can0", interface="socketcan")
    try:
        for addr_str, node_uid in nodes.items():
            addr = int(addr_str)
            print(f"\n🔎 Building tree for node 0x{addr:02X} ({node_uid})")

            tree = {
                "node_uid": node_uid,
                "address": f"0x{addr:02X}",
                "root": explore_id(bus, addr, 0x00, max_depth=16),
            }

            out = f"trees/node_{addr:02X}_tree.json"
            with open(out, "w") as fp:
                json.dump(tree, fp, indent=2, ensure_ascii=False)
            print(f"✅ Saved to {out}")
    finally:
        bus.shutdown()
        print("✅ Exploration complete.")

if __name__ == "__main__":
    main()
