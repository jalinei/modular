#!/usr/bin/env bash
set -euo pipefail

# Configure SocketCAN interface can0 for 500 kbit/s and bring it up.
# Requires root privileges. Intended to be run via pkexec from Electron main.

# Try to bring interface down first (ignore errors if it doesn't exist/up)
ip link set can0 down 2>/dev/null || true

# Set bitrate and restart-ms
ip link set can0 type can bitrate 500000 restart-ms 500

# Bring interface up
ip link set can0 up

echo "can0 configured: 500000 bps, restart-ms 500, up"

