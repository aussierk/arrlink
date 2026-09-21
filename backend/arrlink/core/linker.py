"""The hardlink reconciler."""

from __future__ import annotations

import dataclasses
import os
import time

from ..arr.base import scandir_stats
from ..state import COMMIT_BATCH, State
from .fsutil import create_link, ensure_dir, inode_of, remove_link
from .planner import PlannedLink


def _cached_ino(path: str, cache: dict) -> int | None:
    """Inode from the pre-scanned ``scandir_stats`` cache when the file was
    present at scan time; otherwise a live ``inode_of`` (the file is gone,
    was replaced, or its directory couldn't be read)."""
    st = cache.get(path)
    return st.st_ino if st is not None else inode_of(path)


DEFAULT_DELETE_AFTER = 3


@dataclasses.dataclass
class ReconcileResult:
    created: int = 0
    removed: int = 0
    moved: int = 0
    errors: list[str] = dataclasses.field(default_factory=list)


def reconcile(
    db: State,
    app_id: int,
    app_name: str,
    plan: list[PlannedLink],
    live_srcs: set[str],
    unlink_on_mismatch: bool,
    fallback: str = "skip",
    now: float | None = None,
    delete_after: int | None = None,
) -> ReconcileResult:
    """Reconcile stored links for one app against the current plan."""
    now = now if now is not None else time.time()
    delete_after = delete_after if delete_after is not None else DEFAULT_DELETE_AFTER

    res = ReconcileResult()

    planned: dict[tuple[int, int, str], PlannedLink] = {
        (p.rule_id, p.file_id, p.match_key): p for p in plan if p.file_id is not None
    }
    # Detect two different (rule, file) plans both wanting the same
    # destination path -- e.g. two overlapping rules -- and name both
    # rules explicitly. fsutil.create_link() would eventually catch this
    # too (an inode mismatch when the second create attempt finds the first
    # link already sitting at dst), but only as a generic "name collision"
    # error with no indication of *which* rules are fighting over it.
    seen_dsts: dict[str, tuple[int, int]] = {}
    for p in plan:
        prev = seen_dsts.setdefault(p.dst_path, (p.rule_id, p.file_id))
        if prev != (p.rule_id, p.file_id):
            res.errors.append(
                f"{p.dst_path}: rule {prev[0]} and rule {p.rule_id} both "
                "plan to link here -- only one can occupy this destination; "
                "check for overlapping rules"
            )

    rows = db.query(
        "SELECT * FROM links WHERE app_id=? AND status IN ('active','stale')",
        (app_id,),
    )

    # One lookup for every rule referenced below, instead of a
    # `SELECT * FROM rules WHERE id=?` per non-matching link inside _retire().
    rules_by_id = {r["id"]: r for r in db.query("SELECT * FROM rules")}

    # Batch-stat every existing link's dst + src (and any planned src that
    # lost its snapshot inode) with one os.scandir per directory. On a
    # network mount this collapses the per-link stat round trips in
    # _ensure_present / _retire -- the steady-state cost of a warm poll --
    # to ~one per directory. Snapshot is taken before pass 1 mutates
    # anything; each entry is consulted once, for its own (unique-dst) link.
    stat_cache = scandir_stats(
        [r["dst_path"] for r in rows]
        + [r["src_path"] for r in rows]
        + [p.src_path for p in planned.values() if p.src_inode is None]
    )

    # Both passes interleave real os.link/os.unlink with their DB writes. The
    # transaction wrapper keeps each COMMIT_BATCH-sized chunk atomic while
    # still releasing the WAL writer lock between chunks (so a concurrent API
    # write isn't starved past busy_timeout) and bounding a mid-loop failure's
    # blast radius to one chunk -- the DB and filesystem stay consistent only
    # up to the last committed batch, and the next poll re-reconciles the rest
    # (self-healing, by design).

    # --- pass 1: links we already have -----------------------------------
    with db.transaction():
        for i, row in enumerate(rows):
            if i and i % COMMIT_BATCH == 0:
                db.commit()
            key = (row["rule_id"], row["file_id"], row["match_key"] or "")
            dst = row["dst_path"]
            src = row["src_path"]

            if key in planned:
                p = planned.pop(key)
                if p.dst_path == dst:
                    _ensure_present(db, row, dst, p, res, fallback, now, stat_cache)
                else:
                    # dst changed (file renamed/moved, or template edited) ->
                    # recreate under the new dst, drop the old
                    r = remove_link(dst)
                    if not r.ok and r.error:
                        res.errors.append(f"old link {dst}: {r.error}")
                    if p.file_id is not None:
                        _create(db, p, app_id, res, fallback, now)
                    res.moved += 1
                continue

            # --- key not in plan: rule no longer matches / file deleted ---
            _retire(
                db,
                row,
                src,
                dst,
                live_srcs,
                unlink_on_mismatch,
                res,
                now,
                delete_after,
                fallback,
                rules_by_id,
                stat_cache,
            )

    # --- pass 2: links that should exist but don't ------------------------
    with db.transaction():
        for i, p in enumerate(planned.values()):
            if i and i % COMMIT_BATCH == 0:
                db.commit()
            if p.file_id is None:
                continue
            _create(db, p, app_id, res, fallback, now)

    return res


def _ensure_present(db, row, dst, p, res, fallback, now, stat_cache) -> None:
    """Keep an already-placed link valid (idempotent)."""
    src = p.src_path
    src_ino = p.src_inode if p.src_inode is not None else _cached_ino(src, stat_cache)
    dst_ino = _cached_ino(dst, stat_cache)
    if dst_ino is None:
        # dst vanished on disk: re-create if the source still exists
        if src_ino is not None:
            r = create_link(src, dst, fallback)
            if r.ok:
                res.created += 1
                db.execute(
                    "UPDATE links SET status='active', inode=?, src_path=?, "
                    "missing_strikes=0, created_at=? WHERE id=?",
                    (inode_of(dst), src, now, row["id"]),
                )
            else:
                res.errors.append(f"{dst}: {r.error}")
        else:
            db.execute("UPDATE links SET status='stale' WHERE id=?", (row["id"],))
        return

    if dst_ino != src_ino:
        # source was replaced (e.g. quality upgrade): re-link under the same
        # dst name. The old file's data survives until this unlink.
        r = remove_link(dst)
        if r.ok and src_ino is not None:
            r2 = create_link(src, dst, fallback)
            if r2.ok:
                res.moved += 1
                db.execute(
                    "UPDATE links SET inode=?, src_path=?, missing_strikes=0 WHERE id=?",
                    (inode_of(dst), src, row["id"]),
                )
            else:
                res.errors.append(f"{dst}: {r2.error}")
        return

    # already correct; keep stored metadata in sync
    if dst_ino != row["inode"] or src != row["src_path"]:
        db.execute(
            "UPDATE links SET inode=?, src_path=?, missing_strikes=0 WHERE id=?",
            (dst_ino, src, row["id"]),
        )


def _retire(
    db,
    row,
    src,
    dst,
    live_srcs,
    unlink_on_mismatch,
    res,
    now,
    delete_after,
    fallback,
    rules_by_id,
    stat_cache,
) -> None:
    """Remove (or defer) a link that is no longer planned."""
    rule = rules_by_id.get(row["rule_id"])
    rule_unlink = bool(rule["unlink_on_mismatch"]) if rule else unlink_on_mismatch
    src_exists = src in live_srcs and _cached_ino(src, stat_cache) is not None

    if not src_exists:
        # source gone: grace period before we treat it as deleted
        strikes = (row["missing_strikes"] or 0) + 1
        if row["status"] == "active" and strikes < delete_after:
            db.execute(
                "UPDATE links SET missing_strikes=? WHERE id=?",
                (strikes, row["id"]),
            )
            return
    elif not rule_unlink:
        # source still there but rule no longer matches; user opted out of
        # auto-unlink -> keep it (mark stale so the UI can show it)
        db.execute("UPDATE links SET status='stale' WHERE id=?", (row["id"],))
        return

    r = remove_link(dst)
    if r.ok:
        res.removed += 1
    else:
        res.errors.append(f"remove {dst}: {r.error}")
    db.execute("UPDATE links SET status='missing' WHERE id=?", (row["id"],))


def force_unlink_rule_links(db: State, rule_id: int) -> int:
    """Unconditionally remove every link belonging to a rule being deleted,
    ignoring unlink_on_mismatch -- must run before the rule row is deleted,
    since links.rule_id is ON DELETE SET NULL."""
    rows = db.query(
        "SELECT id, dst_path FROM links WHERE rule_id=? AND status IN ('active','stale')",
        (rule_id,),
    )
    removed = 0
    for row in rows:
        r = remove_link(row["dst_path"])
        if r.ok:
            removed += 1
        db.execute("UPDATE links SET status='missing' WHERE id=?", (row["id"],))
    return removed


def _create(db, p: PlannedLink, app_id: int, res, fallback, now) -> None:
    """Create one planned link (idempotent)."""
    parent = os.path.dirname(p.dst_path)
    if not ensure_dir(parent):
        res.errors.append(f"{p.dst_path}: cannot create parent dir {parent}")
        return
    r = create_link(p.src_path, p.dst_path, fallback)
    if r.ok:
        res.created += 1
        # A prior item/file at this exact destination that was grace-
        # deleted (poller.py) left behind a status='missing' row with
        # item_id/file_id nulled out (so the delete of its now-gone
        # app_items/app_files row wouldn't cascade it away too). That row
        # can never be reused by the INSERT below (NULL never equals NULL
        # in the ON CONFLICT target), so without this it would sit forever
        # as a dead "missing" entry once this destination is legitimately
        # relinked.
        db.execute(
            "DELETE FROM links WHERE app_id=? AND dst_path=? AND status='missing' "
            "AND item_id IS NULL AND file_id IS NULL",
            (app_id, p.dst_path),
        )
        db.execute(
            "INSERT INTO links (rule_id, app_id, item_id, file_id, src_path, "
            "dst_path, inode, status, created_at, missing_strikes, match_key) "
            "VALUES (?,?,?,?,?,?,?, 'active', ?, 0, ?) "
            "ON CONFLICT (rule_id, item_id, file_id, match_key) DO UPDATE SET "
            "dst_path=excluded.dst_path, src_path=excluded.src_path, "
            "inode=excluded.inode, status='active', created_at=excluded.created_at, "
            "missing_strikes=0",
            (
                p.rule_id,
                app_id,
                p.item_id,
                p.file_id,
                p.src_path,
                p.dst_path,
                inode_of(p.dst_path),
                now,
                p.match_key,
            ),
        )
    else:
        res.errors.append(f"{p.dst_path}: {r.error}")
