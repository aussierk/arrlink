"""Cross-process single-instance guard."""
from __future__ import annotations

import fcntl
import json
import os
import socket
import threading
import time
from pathlib import Path
from typing import BinaryIO

LOCK_FILENAME = "arrlink.lock"

_registry_lock = threading.Lock()
# resolved lock-file path -> (open file handle, refcount)
_held: dict[Path, list] = {}


class InstanceLockError(RuntimeError):
    """Raised when another live process already holds the instance lock."""


def _read_holder_info(fh: BinaryIO) -> str:
    try:
        fh.seek(0)
        data = fh.read().decode("utf-8", errors="replace").strip()
        return data or "(no diagnostics recorded)"
    except OSError:
        return "(could not read lock file)"


def acquire_instance_lock(dir_path: Path) -> Path:
    """Acquire the instance lock for `dir_path`. Returns the resolved lock
    file path (the handle callers pass back to `release_instance_lock`).
    Raises InstanceLockError, including the recorded holder's diagnostics,
    if another live process already holds it.
    """
    dir_path = Path(dir_path)
    dir_path.mkdir(parents=True, exist_ok=True)
    lock_path = (dir_path / LOCK_FILENAME).resolve()

    with _registry_lock:
        entry = _held.get(lock_path)
        if entry is not None:
            entry[1] += 1
            return lock_path

        fh = open(lock_path, "a+b")
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as e:
            holder = _read_holder_info(fh)
            fh.close()
            raise InstanceLockError(
                f"another arrlink instance already holds the lock at "
                f"{lock_path} (recorded holder: {holder}). Stop the other "
                f"instance, or if you're certain it's dead and your "
                f"filesystem doesn't honor advisory locks, remove "
                f"{lock_path} and restart."
            ) from e

        fh.seek(0)
        fh.truncate()
        fh.write(
            json.dumps(
                {
                    "pid": os.getpid(),
                    "hostname": socket.gethostname(),
                    "started_at": time.time(),
                }
            ).encode("utf-8")
        )
        fh.flush()
        _held[lock_path] = [fh, 1]
        return lock_path


def release_instance_lock(lock_path: Path) -> None:
    with _registry_lock:
        entry = _held.get(lock_path)
        if entry is None:
            return
        entry[1] -= 1
        if entry[1] > 0:
            return
        fh, _ = entry
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        fh.close()
        del _held[lock_path]
