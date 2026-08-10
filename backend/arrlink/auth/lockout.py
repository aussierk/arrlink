"""Password-login lockout: a flat lockout after too many failed attempts."""
from __future__ import annotations

import time
from typing import NamedTuple

from ..state import State

# Flat lockout, not exponential backoff -- a single-account model doesn't
# benefit from that complexity. 5 failures within a 15-minute window locks
# the account for 15 minutes. Hardcoded, not Settings-editable: anyone who
# can already reach PUT /api/settings shouldn't be able to raise or disable
# the very control meant to slow down a credential-guessing client hitting
# POST /api/auth/password.
THRESHOLD = 5
WINDOW_S = 15 * 60.0
LOCKOUT_S = 15 * 60.0


class LockoutStatus(NamedTuple):
    locked: bool
    locked_until: float | None
    fail_count: int


def _row(db: State, username: str) -> dict | None:
    row = db.query_one(
        "SELECT * FROM login_attempts WHERE username=?", (username,)
    )
    return dict(row) if row else None


def status(db: State, username: str) -> LockoutStatus:
    row = _row(db, username)
    if row is None:
        return LockoutStatus(False, None, 0)
    locked_until = row["locked_until"]
    locked = bool(locked_until and locked_until > time.time())
    return LockoutStatus(locked, locked_until if locked else None, row["fail_count"])


def record_failure(db: State, username: str) -> LockoutStatus:
    """Record one failed attempt. No-op on the counters while already
    locked (doesn't extend the lockout window on repeated guesses against a
    locked account)."""
    now = time.time()
    row = _row(db, username)
    was_locked = bool(row and row["locked_until"] and row["locked_until"] > now)

    if was_locked:
        return LockoutStatus(True, row["locked_until"], row["fail_count"])

    if row is None or not row["first_fail_at"] or now - row["first_fail_at"] > WINDOW_S:
        # No row yet, or the previous window (or a since-expired lockout's
        # window) has passed: start fresh.
        fail_count = 1
        first_fail_at = now
    else:
        fail_count = row["fail_count"] + 1
        first_fail_at = row["first_fail_at"]

    locked_until = now + LOCKOUT_S if fail_count >= THRESHOLD else None

    db.execute(
        "INSERT INTO login_attempts (username, fail_count, first_fail_at, "
        "last_fail_at, locked_until) VALUES (?,?,?,?,?) "
        "ON CONFLICT(username) DO UPDATE SET fail_count=excluded.fail_count, "
        "first_fail_at=excluded.first_fail_at, last_fail_at=excluded.last_fail_at, "
        "locked_until=excluded.locked_until",
        (username, fail_count, first_fail_at, now, locked_until),
    )
    db.commit()

    if locked_until is not None:
        # was_locked is already known False here, so any locked_until we
        # just set is a fresh transition -- log once, not on every
        # subsequent attempt during the lockout (those hit the early
        # return above instead).
        db.log_event(
            "warn",
            f"password login locked for {LOCKOUT_S / 60:.0f} min after "
            f"{fail_count} failed attempts (username={username!r})",
        )

    return LockoutStatus(locked_until is not None, locked_until, fail_count)


def reset(db: State, username: str) -> None:
    db.execute("DELETE FROM login_attempts WHERE username=?", (username,))
    db.commit()
