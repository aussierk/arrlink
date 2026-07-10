#!/bin/sh
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
PORT="${PORT:-8270}"

# Take ownership of writable volumes for the runtime user.
chown -R "${PUID}:${PGID}" /config 2>/dev/null || true
[ -d /linked ] && chown -R "${PUID}:${PGID}" /linked 2>/dev/null || true

exec gosu "${PUID}:${PGID}" python -m uvicorn arrlink.main:app \
    --host 0.0.0.0 --port "${PORT}" \
    --proxy-headers --forwarded-allow-ips "*"
