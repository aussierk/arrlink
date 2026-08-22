"""Unit tests for singleton.py -- the cross-process single-instance guard."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from arrlink.main import create_app
from arrlink.singleton import (
    InstanceLockError,
    acquire_instance_lock,
    release_instance_lock,
)
from fastapi.testclient import TestClient

import arrlink

_BACKEND_SRC_DIR = str(Path(arrlink.__file__).resolve().parents[1])


def _acquire_lock_in_subprocess(dir_path: Path, hold_seconds: float = 0) -> None:
    """Runs a real, separate Python process that acquires the lock (and
    optionally holds it for a bit before exiting normally) -- the genuine
    cross-process scenario this module exists for, not a same-process
    simulation."""
    script = (
        "import sys, time\n"
        f"sys.path.insert(0, {_BACKEND_SRC_DIR!r})\n"
        "from arrlink.singleton import acquire_instance_lock\n"
        f"acquire_instance_lock({str(dir_path)!r})\n"
        f"time.sleep({hold_seconds})\n"
    )
    subprocess.run([sys.executable, "-c", script], check=True, timeout=10)


def test_acquire_and_release_allows_reacquire(tmp_path):
    p = acquire_instance_lock(tmp_path)
    release_instance_lock(p)
    p2 = acquire_instance_lock(tmp_path)
    release_instance_lock(p2)


def test_concurrent_acquire_from_another_process_raises(tmp_path):
    """The real cross-process conflict: a separate process holds the lock
    (and stays alive, via a background subprocess) while this process
    tries to acquire the same one."""
    proc = subprocess.Popen(
        [
            sys.executable,
            "-c",
            (
                "import sys, time\n"
                f"sys.path.insert(0, {_BACKEND_SRC_DIR!r})\n"
                "from arrlink.singleton import acquire_instance_lock\n"
                f"acquire_instance_lock({str(tmp_path)!r})\n"
                "time.sleep(5)\n"
            ),
        ]
    )
    try:
        # give the subprocess a moment to actually acquire the lock
        import time

        for _ in range(50):
            if (tmp_path / "arrlink.lock").exists():
                break
            time.sleep(0.05)

        with pytest.raises(InstanceLockError) as exc_info:
            acquire_instance_lock(tmp_path)
        msg = str(exc_info.value)
        assert "arrlink.lock" in msg
        assert "recorded holder" in msg
    finally:
        proc.kill()
        proc.wait(timeout=5)


def test_lock_file_contains_diagnostics(tmp_path):
    p = acquire_instance_lock(tmp_path)
    try:
        data = json.loads(p.read_text())
        assert data["pid"] == os.getpid()
        assert "hostname" in data
        assert "started_at" in data
    finally:
        release_instance_lock(p)


def test_stale_lock_released_on_process_exit(tmp_path):
    """The single most important test here: proves the flock-over-PID-file
    design decision -- a process holding the lock that simply exits (no
    explicit cleanup, exactly what a crash looks like) releases it
    automatically, with zero staleness-detection code needed."""
    _acquire_lock_in_subprocess(tmp_path)  # acquires, then exits immediately

    # the subprocess has already exited -- a fresh acquire in this process
    # must succeed right away
    p = acquire_instance_lock(tmp_path)
    release_instance_lock(p)


def test_create_app_twice_same_process_same_dir_is_allowed(tmp_path, monkeypatch):
    """Deliberate: same-process reentrancy is allowed."""
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    db_path = tmp_path / "arrlink.db"
    create_app(db_path=db_path)
    create_app(db_path=db_path)  # no raise
    lock_path = (tmp_path / "arrlink.lock").resolve()
    # release both refcounted acquisitions -- normally done by each app's
    # lifespan finally: block, done manually here since neither ever
    # entered a TestClient context
    release_instance_lock(lock_path)
    release_instance_lock(lock_path)


def test_sequential_create_app_same_dir_ok(tmp_path, monkeypatch):
    """A restart against the same config dir (release on shutdown, then a
    fresh acquire) must work -- this is the ordinary, legitimate case."""
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    db_path = tmp_path / "arrlink.db"

    with TestClient(create_app(db_path=db_path)) as c1:
        assert c1.get("/api/health").status_code == 200

    with TestClient(create_app(db_path=db_path)) as c2:
        assert c2.get("/api/health").status_code == 200
