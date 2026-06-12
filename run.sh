#!/usr/bin/env bash
# Serve NIGHT CITY — Pixel Edition on http://localhost:8080
cd "$(dirname "$0")"
PORT="${1:-8080}"
echo "NIGHT CITY — Pixel Edition  →  http://localhost:${PORT}"
python3 -m http.server "$PORT"
