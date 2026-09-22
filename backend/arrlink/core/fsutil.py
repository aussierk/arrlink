"""Filesystem primitives for the hardlinker.

All operations are defensive: we only ever create/remove entries that we
created ourselves (tracked in the `links` table), and we verify inodes before
deleting anything.
"""

from __future__ import annotations

import os
import shutil
import stat as stat_mod
from dataclasses import dataclass


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
    """Hardlink src -> dst, with the configured fallback on cross-device."""
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

    dev = same_device(src, os.path.dirname(dst) or ".")
    if dev is False and fallback == "skip":
        return LinkResult(False, dst, "cross-filesystem (hardlink impossible)")

    if dev is False and fallback == "symlink":
        try:
            os.symlink(src, dst)
            return LinkResult(True, dst)
        except OSError as e:
            return LinkResult(False, dst, f"{e.__class__.__name__}: {e}")

    try:
        fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as e:
        return LinkResult(False, dst, f"source changed before linking: {e}")
    try:
        st = os.fstat(fd)
        if not stat_mod.S_ISREG(st.st_mode):
            return LinkResult(False, dst, "source changed before linking (not a regular file)")

        if dev is False and fallback == "copy":
            try:
                with os.fdopen(fd, "rb", closefd=False) as sf, open(dst, "wb") as df:
                    shutil.copyfileobj(sf, df)
                os.chmod(dst, stat_mod.S_IMODE(st.st_mode))
                os.utime(dst, (st.st_atime, st.st_mtime))
            except OSError as e:
                return LinkResult(False, dst, f"{e.__class__.__name__}: {e}")
            return LinkResult(True, dst)

        try:
            os.link(src, dst, follow_symlinks=False)
        except OSError as e:
            return LinkResult(False, dst, f"{e.__class__.__name__}: {e}")

        dlst = os.lstat(dst)
        if (
            not stat_mod.S_ISREG(dlst.st_mode)
            or dlst.st_ino != st.st_ino
            or dlst.st_dev != st.st_dev
        ):
            try:
                os.unlink(dst)
            except OSError:
                pass
            return LinkResult(False, dst, "source changed during linking (aborted)")
        return LinkResult(True, dst)
    finally:
        os.close(fd)


def resolve_fs_fallback(db, env_default: str = "skip") -> str:
    """The effective cross-filesystem fallback mode.

    A runtime value set via the ``fs_fallback`` Setting (Settings page) takes
    precedence over the process/env default; both are normalized to a valid
    mode (skip | copy | symlink).
    """
    from ..config import normalize_fs_fallback

    value = db.get_setting("fs_fallback") if db is not None else None
    return normalize_fs_fallback(value, env_default)


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
