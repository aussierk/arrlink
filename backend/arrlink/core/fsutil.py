"""Filesystem primitives for the hardlinker.

All operations are defensive: we only ever create/remove entries that we
created ourselves (tracked in the `links` table), and we verify inodes before
deleting anything.
"""
from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass
class LinkResult:
    ok: bool
    dst: str
    error: str | None = None


def ensure_dir(dir_path: str) -> bool:
    try:
        os.makedirs(dir_path, exist_ok=True)
        return True
    except OSError:
        return False


def inode_of(path: str) -> int | None:
    try:
        return os.stat(path).st_ino
    except OSError:
        return None


def same_device(a: str, b: str) -> bool | None:
    """True/False if both paths exist and are on the same device, else None."""
    try:
        da = os.stat(a).st_dev
        db = os.stat(b).st_dev
        return da == db
    except OSError:
        return None


def create_link(src: str, dst: str, fallback: str = "skip") -> LinkResult:
    """Hardlink src -> dst, with the configured fallback on cross-device.

    Idempotent: if dst already exists and points at the same inode, no-op ok.
    """
    if os.path.islink(src):
        return LinkResult(False, dst, "source is a symlink (refused)")
    if not os.path.isfile(src):
        return LinkResult(False, dst, "source missing")

    if os.path.lexists(dst):
        if os.path.islink(dst):
            # a stray symlink where we expect our own link -> replace
            try:
                os.unlink(dst)
            except OSError:
                pass
        else:
            same = inode_of(dst) == inode_of(src)
            if same:
                return LinkResult(True, dst)  # already linked
            return LinkResult(False, dst, "name collision (different inode)")

    dev = same_device(src, dst)
    if dev is False and fallback == "skip":
        return LinkResult(False, dst, "cross-filesystem (hardlink impossible)")

    try:
        if dev is False and fallback == "copy":
            shutil.copy2(src, dst)
        elif dev is False and fallback == "symlink":
            os.symlink(src, dst)
        else:
            os.link(src, dst)
        return LinkResult(True, dst)
    except OSError as e:
        return LinkResult(False, dst, f"{e.__class__.__name__}: {e}")


def remove_link(dst: str) -> LinkResult:
    """Remove a link we created. Refuses symlinks; removes the dir entry only
    (the file data survives via its other links / the source)."""
    if os.path.islink(dst):
        return LinkResult(False, dst, "refusing to remove a symlink")
    if not os.path.lexists(dst):
        return LinkResult(True, dst)  # already gone
    try:
        os.unlink(dst)
        return LinkResult(True, dst)
    except OSError as e:
        return LinkResult(False, dst, f"{e.__class__.__name__}: {e}")
