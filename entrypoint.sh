#!/bin/sh
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
PORT="${PORT:-8270}"
# IP(s)/CIDR(s) of a trusted reverse proxy in front of this container, so
# uvicorn only honors X-Forwarded-For/-Proto from that peer -- NOT from
# any client, which "*" would (spoofable client IPs in logs, and a
# spoofable scheme feeding _secure() in api/auth.py's cookie Secure flag).
# Defaults to uvicorn's own conservative default (localhost only); a
# containerized reverse proxy reaches this over the Docker network, not
# 127.0.0.1, so set this explicitly to that proxy's address/CIDR if one is
# in front of arrlink. Left untouched (no proxy), forwarded headers are
# simply ignored -- safe, since compose.yaml publishes the port directly.
FORWARDED_ALLOW_IPS="${FORWARDED_ALLOW_IPS:-127.0.0.1}"

# Take ownership of writable volumes for the runtime user.
chown -R "${PUID}:${PGID}" /config 2>/dev/null || true
[ -d /linked ] && chown -R "${PUID}:${PGID}" /linked 2>/dev/null || true

# --factory, not arrlink.main:app: create_app() now acquires the
# single-instance lock (singleton.py) as a side effect of being called, so
# it must only run when uvicorn actually starts the server -- a bare
# module-level `app = create_app()` would acquire a real lock the instant
# anything merely imports arrlink.main (e.g. a local dev server and a
# concurrent test run against the same default ./config path).
exec gosu "${PUID}:${PGID}" python -m uvicorn arrlink.main:create_app --factory \
    --host 0.0.0.0 --port "${PORT}" \
    --proxy-headers --forwarded-allow-ips "${FORWARDED_ALLOW_IPS}"
