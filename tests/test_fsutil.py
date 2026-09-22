"""Unit tests for core/fsutil.py's create_link/remove_link primitives,
focused on the TOCTOU-hardening in create_link (O_NOFOLLOW + post-hoc
inode verification)."""

from __future__ import annotations

import os

from arrlink.arr.base import scandir_stats
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


def test_create_link_copy_fallback_engages_for_a_fresh_dst_via_real_same_device(tmp_path, monkeypatch):
    """Regression test: same_device(src, dst) always os.stat'd dst itself, but
    a fresh dst never exists yet -- so it always returned None (never True/
    False) and no fallback branch in create_link ever engaged; every real
    cross-device link fell through to a raw, unhandled cross-device OSError.
    Fixed by stat-ing dst's *parent* directory instead, which does exist by
    the time create_link runs. A genuine cross-device mount isn't available
    in CI, so this fakes differing st_dev via a real os.stat wrapper (not by
    monkeypatching same_device itself, which would just re-assert the fix and
    miss the bug it's guarding against)."""
    import arrlink.core.fsutil as fsutil

    src_dir = tmp_path / "src_fs"
    dst_dir = tmp_path / "dst_fs"
    src_dir.mkdir()
    dst_dir.mkdir()
    src = src_dir / "movie.mkv"
    src.write_text("hello")
    dst = dst_dir / "movie.mkv"

    real_stat = os.stat

    def fake_stat(path, *args, **kwargs):
        st = real_stat(path, *args, **kwargs)
        path_str = os.fspath(path)
        fake_dev = 1 if path_str.startswith(str(src_dir)) else 2
        return os.stat_result(
            (
                st.st_mode,
                st.st_ino,
                fake_dev,
                st.st_nlink,
                st.st_uid,
                st.st_gid,
                st.st_size,
                st.st_atime,
                st.st_mtime,
                st.st_ctime,
            )
        )

    monkeypatch.setattr(fsutil.os, "stat", fake_stat)

    r = create_link(str(src), str(dst), fallback="copy")
    assert r.ok is True
    assert dst.read_text() == "hello"
    assert inode_of(str(src)) != inode_of(str(dst))


def test_create_link_refuses_symlink_even_if_early_check_is_bypassed(tmp_path, monkeypatch):
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


def test_scandir_stats_batches_by_dir_and_matches_os_stat(tmp_path, monkeypatch):
    d1 = tmp_path / "Show" / "Season 01"
    d2 = tmp_path / "Movie (2020)"
    d1.mkdir(parents=True)
    d2.mkdir()
    files = [d1 / "E01.mkv", d1 / "E02.mkv", d1 / "E03.mkv", d2 / "movie.mkv"]
    for i, f in enumerate(files):
        f.write_bytes(b"x" * (i + 1))
    missing = str(tmp_path / "gone" / "nope.mkv")

    scandirs: list[str] = []
    real = os.scandir
    monkeypatch.setattr(os, "scandir", lambda p=".": scandirs.append(str(p)) or real(p))

    got = scandir_stats([str(f) for f in files] + [missing])

    # one os.scandir per distinct parent dir (Season 01, Movie, gone) --
    # 3, not one os.stat per path (5); the gone dir's scandir fails quietly
    assert len(scandirs) == 3
    assert set(got) == {str(f) for f in files}  # missing path simply absent
    for f in files:
        assert got[str(f)].st_ino == os.stat(f).st_ino
        assert got[str(f)].st_size == f.stat().st_size
