"""OIDC sessions: creation, lookup, revocation, and *silent refresh*."""

from __future__ import annotations

import json
import secrets
import time
from collections.abc import Callable
from typing import Any

from ..state import State

REFRESH_TOKEN_COOKIE = "arrlink_rt"
REFRESH_LEEWAY_S = 60.0
SWEEP_INTERVAL_S = 30.0


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def create_session(
    db: State,
    email: str,
    name: str | None,
    groups: list[str],
    refresh_token: str | None,
    ttl_h: float,
    kind: str = "oidc",
) -> tuple[str, float, float]:
    """Insert a session; returns (token, created_at, expires_at)."""
    token = new_session_token()
    now = time.time()
    expires = now + ttl_h * 3600
    db.execute(
        "INSERT INTO sessions (token, email, name, groups_json, refresh_token, "
        "created_at, expires_at, kind) VALUES (?,?,?,?,?,?,?,?)",
        (token, email, name, json.dumps(groups), refresh_token, now, expires, kind),
    )
    db.commit()
    return token, now, expires


def get_session(db: State, token: str) -> dict[str, Any] | None:
    row = db.query_one("SELECT * FROM sessions WHERE token=?", (token,))
    if row is None:
        return None
    d = dict(row)
    d["groups"] = json.loads(d.pop("groups_json") or "[]")
    return d


def revoke_session(db: State, token: str) -> None:
    db.execute("DELETE FROM sessions WHERE token=?", (token,))
    db.commit()


def touch_expiry(db: State, token: str, ttl_h: float) -> float:
    expires = time.time() + ttl_h * 3600
    db.execute("UPDATE sessions SET expires_at=? WHERE token=?", (expires, token))
    db.commit()
    return expires


def _silent_refresh(
    db: State, token: str, refresh_token: str | None, client: Any, ttl_h: float
) -> float | None:
    """Refresh the provider token set; returns new local expiry or None on failure."""
    try:
        tok = client.refresh_tokens(refresh_token)
    except Exception:  # noqa: BLE001 - any provider failure ends the session
        return None
    new_rt = tok.get("refresh_token")
    # Provider may rotate the refresh token; keep the old one if none was sent.
    db.execute(
        "UPDATE sessions SET refresh_token=?, expires_at=? WHERE token=?",
        (new_rt or refresh_token, time.time() + ttl_h * 3600, token),
    )
    db.commit()
    return time.time() + ttl_h * 3600


def refresh_due(db: State) -> list[dict[str, Any]]:
    """Sessions expiring within the leeway window (or already expired) that
    still hold a provider refresh token."""
    cutoff = time.time() + REFRESH_LEEWAY_S
    return [
        dict(r)
        for r in db.query(
            "SELECT * FROM sessions WHERE refresh_token IS NOT NULL AND expires_at <= ?",
            (cutoff,),
        )
    ]


def run_sweep(db: State, client_factory: Callable[[], Any], ttl_h: float) -> dict:
    """One sweep pass: refresh due sessions, purge expired ones.

    Returns stats for the events log / tests.
    """
    stats = {"refreshed": 0, "failed": 0, "purged": 0}
    client = None
    for s in refresh_due(db):
        try:
            if client is None:
                client = client_factory()
            expires = _silent_refresh(db, s["token"], s["refresh_token"], client, ttl_h)
            if expires is None:
                stats["failed"] += 1
                db.log_event(
                    "warn",
                    f"session for {s['email']} dropped: OIDC refresh rejected",
                )
                revoke_session(db, s["token"])
            else:
                stats["refreshed"] += 1
        except Exception as e:  # noqa: BLE001 - keep sweeping other sessions
            db.log_event("error", f"session refresh error: {e}")
    # Expired sessions without a refresh token (or after failed refresh): purge.
    cur = db.execute("DELETE FROM sessions WHERE expires_at < ?", (time.time() - 1,))
    stats["purged"] = cur.rowcount
    db.commit()
    return stats
