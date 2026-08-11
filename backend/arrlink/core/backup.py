"""Nightly DB backup with retention."""
from __future__ import annotations

import logging
import sqlite3
import time
from pathlib import Path

log = logging.getLogger(__name__)

BACKUP_SUBDIR = "backups"
FILENAME_FMT = "arrlink-%Y%m%d-%H%M%S.db"
FILENAME_GLOB = "arrlink-*.db"
# How often the background loop checks whether a backup is due, and how
# stale the newest backup has to be before one runs. A staleness check
# (not a fixed-clock-time scheduler) is restart-safe -- there's no
# in-memory "next run at" timer to lose, and a fresh install gets its
# first backup promptly instead of waiting up to a full day.
CHECK_INTERVAL_S = 3600.0
STALE_S = 24 * 3600.0


def backup_now(db_path: Path, backup_dir: Path) -> Path:
    """Create one backup of `db_path` under `backup_dir`. Returns the new
    file's path. Raises on failure -- callers that want a non-raising,
    logged outcome should use `run_backup_cycle` instead."""
    backup_dir.mkdir(parents=True, exist_ok=True)
    dest = backup_dir / time.strftime(FILENAME_FMT, time.localtime())
    src_conn = sqlite3.connect(str(db_path))
    try:
        dst_conn = sqlite3.connect(str(dest))
        try:
            src_conn.backup(dst_conn)
        finally:
            dst_conn.close()
    finally:
        src_conn.close()
    return dest


def prune_old_backups(backup_dir: Path, retention_days: int) -> list[Path]:
    """Delete backups (matching FILENAME_GLOB only -- never touches
    unrelated files an admin might also keep in this directory) older than
    `retention_days`. Returns the paths removed."""
    if not backup_dir.is_dir():
        return []
    cutoff = time.time() - retention_days * 86400
    removed = []
    for p in backup_dir.glob(FILENAME_GLOB):
        try:
            if p.stat().st_mtime < cutoff:
                p.unlink()
                removed.append(p)
        except OSError as e:
            log.warning("failed to prune backup %s: %s", p, e)
    return removed


def newest_backup_age_s(backup_dir: Path) -> float | None:
    """Age in seconds of the newest backup, or None if there are none yet
    (or the directory doesn't exist)."""
    if not backup_dir.is_dir():
        return None
    times = [p.stat().st_mtime for p in backup_dir.glob(FILENAME_GLOB)]
    if not times:
        return None
    return time.time() - max(times)


def list_backups(backup_dir: Path) -> list[dict]:
    if not backup_dir.is_dir():
        return []
    out = []
    for p in sorted(backup_dir.glob(FILENAME_GLOB), reverse=True):
        try:
            st = p.stat()
        except OSError:
            continue
        out.append({"name": p.name, "size": st.st_size, "created_at": st.st_mtime})
    return out


def run_backup_cycle(db, db_path: Path, backup_dir: Path, retention_days: int) -> dict:
    """Back up, prune, and log the outcome via `db.log_event`."""
    try:
        dest = backup_now(db_path, backup_dir)
        size = dest.stat().st_size
        removed = prune_old_backups(backup_dir, retention_days)
        db.log_event(
            "info",
            f"DB backup created: {dest.name} ({size} bytes)"
            + (f", pruned {len(removed)} old backup(s)" if removed else ""),
        )
        return {"ok": True, "path": str(dest), "size": size, "pruned": len(removed)}
    except Exception as e:  # noqa: BLE001 - never crash the app over a backup
        db.log_event("error", f"DB backup failed: {e}")
        return {"ok": False, "error": str(e)}
