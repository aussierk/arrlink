"""Unit tests for core/backup.py -- nightly DB backup with retention."""
from __future__ import annotations

import os
import sqlite3
import threading
import time

from arrlink.core.backup import (
    backup_now,
    list_backups,
    newest_backup_age_s,
    prune_old_backups,
    run_backup_cycle,
)
from arrlink.state import State


def test_backup_now_creates_consistent_copy(tmp_path):
    db_path = tmp_path / "arrlink.db"
    db = State(db_path)
    db.log_event("info", "hello")
    db.commit()

    dest = backup_now(db_path, tmp_path / "backups")
    assert dest.exists()

    conn = sqlite3.connect(str(dest))
    try:
        rows = conn.execute("SELECT message FROM events").fetchall()
        assert ("hello",) in rows
        version = conn.execute("SELECT version FROM schema_version").fetchone()[0]
        assert version == db.query_one("SELECT version FROM schema_version")["version"]
    finally:
        conn.close()


def test_backup_concurrent_writes_produce_valid_copy(tmp_path):
    db_path = tmp_path / "arrlink.db"
    db = State(db_path)

    stop = threading.Event()

    def hammer():
        i = 0
        while not stop.is_set():
            db.log_event("info", f"event {i}")
            i += 1

    t = threading.Thread(target=hammer)
    t.start()
    try:
        time.sleep(0.05)  # let some writes land first
        dest = backup_now(db_path, tmp_path / "backups")
    finally:
        stop.set()
        t.join()

    conn = sqlite3.connect(str(dest))
    try:
        result = conn.execute("PRAGMA integrity_check").fetchone()[0]
        assert result == "ok"
    finally:
        conn.close()


def test_prune_old_backups_only_removes_stale_arrlink_files(tmp_path):
    backup_dir = tmp_path / "backups"
    backup_dir.mkdir()

    old = backup_dir / "arrlink-20200101-000000.db"
    old.write_text("old")
    new = backup_dir / "arrlink-20991231-000000.db"
    new.write_text("new")
    unrelated = backup_dir / "notes.txt"
    unrelated.write_text("keep me")

    old_time = time.time() - 30 * 86400
    os.utime(old, (old_time, old_time))

    removed = prune_old_backups(backup_dir, retention_days=7)

    assert not old.exists()
    assert new.exists()
    assert unrelated.exists()
    assert removed == [old]


def test_newest_backup_age_s_none_when_empty(tmp_path):
    assert newest_backup_age_s(tmp_path / "backups") is None


def test_newest_backup_age_s_reflects_most_recent(tmp_path):
    backup_dir = tmp_path / "backups"
    backup_dir.mkdir()
    older = backup_dir / "arrlink-20200101-000000.db"
    older.write_text("x")
    os.utime(older, (time.time() - 1000, time.time() - 1000))
    newer = backup_dir / "arrlink-20991231-000000.db"
    newer.write_text("x")
    os.utime(newer, (time.time() - 5, time.time() - 5))

    age = newest_backup_age_s(backup_dir)
    assert 0 <= age < 10


def test_run_backup_cycle_logs_success_event(tmp_path):
    db_path = tmp_path / "arrlink.db"
    db = State(db_path)

    result = run_backup_cycle(db, db_path, tmp_path / "backups", retention_days=7)
    assert result["ok"] is True

    rows = db.query("SELECT level, message FROM events ORDER BY id DESC LIMIT 5")
    assert any(r["level"] == "info" and "backup created" in r["message"] for r in rows)


def test_run_backup_cycle_logs_failure_event(tmp_path, monkeypatch):
    db_path = tmp_path / "arrlink.db"
    db = State(db_path)

    import arrlink.core.backup as backup_mod

    def boom(*a, **kw):
        raise OSError("disk full")

    monkeypatch.setattr(backup_mod, "backup_now", boom)
    result = run_backup_cycle(db, db_path, tmp_path / "backups", retention_days=7)
    assert result["ok"] is False

    rows = db.query("SELECT level, message FROM events ORDER BY id DESC LIMIT 5")
    assert any(r["level"] == "error" and "backup failed" in r["message"] for r in rows)


def test_list_backups(tmp_path):
    backup_dir = tmp_path / "backups"
    db_path = tmp_path / "arrlink.db"
    State(db_path)
    backup_now(db_path, backup_dir)

    out = list_backups(backup_dir)
    assert len(out) == 1
    assert out[0]["name"].startswith("arrlink-")
    assert out[0]["size"] > 0


def test_backup_endpoint_manual_trigger(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from arrlink.main import create_app

    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    app = create_app(db_path=tmp_path / "arrlink.db")
    with TestClient(app) as c:
        r = c.post("/api/backup/run")
        assert r.status_code == 200
        assert r.json()["ok"] is True

        listed = c.get("/api/backup")
        assert listed.status_code == 200
        assert len(listed.json()) == 1
