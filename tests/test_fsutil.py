"""Unit tests for core/fsutil.py's create_link/remove_link primitives,
focused on the TOCTOU-hardening in create_link (O_NOFOLLOW + post-hoc
inode verification)."""
from __future__ import annotations

import os

from arrlink.core.fsutil import create_link, inode_of, remove_link


def test_create_link_hardlinks_regular_file(tmp_path):
    src = tmp_path / "src.txt"
    src.write_text("hello")
    dst = tmp_path / "dst.txt"

    r = create_link(str(src), str(dst), fallback="skip")
    assert r.ok is True
    assert inode_of(str(src)) == inode_of(str(dst))


def test_create_link_idempotent_when_already_linked(tmp_path):
    src = tmp_path / "src.txt"
    src.write_text("hello")
    dst = tmp_path / "dst.txt"
    os.link(src, dst)

    r = create_link(str(src), str(dst), fallback="skip")
    assert r.ok is True


def test_create_link_refuses_name_collision_different_inode(tmp_path):
    src = tmp_path / "src.txt"
    src.write_text("hello")
    dst = tmp_path / "dst.txt"
    dst.write_text("someone else's file")

    r = create_link(str(src), str(dst), fallback="skip")
    assert r.ok is False
    assert "collision" in r.error
    assert dst.read_text() == "someone else's file"


def test_create_link_refuses_symlink_source(tmp_path):
    real = tmp_path / "real.txt"
    real.write_text("x")
    src = tmp_path / "src.txt"
    src.symlink_to(real)
    dst = tmp_path / "dst.txt"

    r = create_link(str(src), str(dst), fallback="skip")
    assert r.ok is False
    assert "symlink" in r.error
    assert not dst.exists()


def test_create_link_copy_fallback_duplicates_content(tmp_path, monkeypatch):
    import arrlink.core.fsutil as fsutil

    src = tmp_path / "src.txt"
    src.write_text("hello")
    dst = tmp_path / "dst.txt"
    monkeypatch.setattr(fsutil, "same_device", lambda a, b: False)

    r = create_link(str(src), str(dst), fallback="copy")
    assert r.ok is True
    assert dst.read_text() == "hello"
    assert inode_of(str(src)) != inode_of(str(dst))


def test_create_link_refuses_symlink_even_if_early_check_is_bypassed(
    tmp_path, monkeypatch
):
    """Regression test: TOCTOU hardening."""
    import arrlink.core.fsutil as fsutil

    secret = tmp_path / "secret.txt"
    secret.write_text("do not link me")
    src = tmp_path / "movie.mkv"
    src.symlink_to(secret)
    dst = tmp_path / "linked" / "movie.mkv"
    dst.parent.mkdir()

    monkeypatch.setattr(fsutil.os.path, "islink", lambda p: False)
    monkeypatch.setattr(fsutil.os.path, "isfile", lambda p: True)

    r = create_link(str(src), str(dst), fallback="skip")
    assert r.ok is False
    assert not dst.exists()


def test_remove_link_refuses_symlink(tmp_path):
    target = tmp_path / "target.txt"
    target.write_text("x")
    link = tmp_path / "link.txt"
    link.symlink_to(target)

    r = remove_link(str(link))
    assert r.ok is False
    assert "symlink" in r.error
    assert link.exists()


def test_remove_link_already_gone_is_ok(tmp_path):
    r = remove_link(str(tmp_path / "nonexistent.txt"))
    assert r.ok is True
