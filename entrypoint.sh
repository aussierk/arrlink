#!/bin/sh
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
PORT="${PORT:-8270}"
export PORT
# IP(s)/CIDR(s) of a trusted reverse proxy in front of this container, so the
# app only honors X-Forwarded-For/-Proto from that peer -- NOT from any
# client, which would let a client spoof its scheme/IP (see app.ts's
# Fastify `trustProxy` option and api/auth.ts's secure() cookie flag).
# Defaults to loopback; a containerized reverse proxy reaches this over the
# Docker network, not 127.0.0.1, so set this explicitly to that proxy's
# address/CIDR if one is in front of arrlink. Left untouched, forwarded
# headers are ignored -- safe, since compose.yaml publishes the port directly.
export FORWARDED_ALLOW_IPS="${FORWARDED_ALLOW_IPS:-127.0.0.1}"

# Take ownership of writable volumes for the runtime user.
chown -R "${PUID}:${PGID}" /config 2>/dev/null || true
[ -d /linked ] && chown -R "${PUID}:${PGID}" /linked 2>/dev/null || true

# createApp() acquires the single-instance lock (singleton.ts) as a side
# effect of being called from index.ts's main(), not at import time -- so
# there's no equivalent risk here to Python's --factory flag guarding
# against a bare module-level `app = create_app()`.
exec su-exec "${PUID}:${PGID}" node dist/index.js
