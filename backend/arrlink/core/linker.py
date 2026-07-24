"""The hardlink reconciler."""
from __future__ import annotations

import dataclasses
import os
import time

from ..state import State
from .fsutil import create_link, ensure_dir, inode_of, remove_link
from .planner import PlannedLink

DEFAULT_DELETE_AFTER = 3


@dataclasses.dataclass
class ReconcileResult:
    created: int = 0
    removed: int = 0
    moved: int = 0
    skipped: int = 0
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
    seen_dsts: dict[str, tuple[int, int]] = {}
    for p in plan:
        seen_dsts.setdefault(p.dst_path, (p.rule_id, p.file_id))

    rows = db.query(
        "SELECT * FROM links WHERE app_id=? AND status IN ('active','stale')",
        (app_id,),
    )

    # --- pass 1: links we already have -----------------------------------
    for row in rows:
        key = (row["rule_id"], row["file_id"], row["match_key"] or "")
        dst = row["dst_path"]
        src = row["src_path"]

        if key in planned:
            p = planned.pop(key)
            if p.dst_path == dst:
                _ensure_present(db, row, src, dst, p, res, fallback, now)
            else:
                # dst changed (file renamed/moved, or template edited) ->
                # recreate under the new dst, drop the old
                r = remove_link(dst)
                if not r.ok and r.error:
                    res.errors.append(f"old link {dst}: {r.error}")
                if p.file_id is not None:
                    _create(db, p, app_id, res, fallback, now)
                else:
                    res.skipped += 1
                res.moved += 1
            continue

        # --- key not in plan: rule no longer matches / file deleted -------
        _retire(db, row, src, dst, live_srcs, unlink_on_mismatch, res, now,
                delete_after, fallback)

    # --- pass 2: links that should exist but don't ------------------------
    for p in planned.values():
        if p.file_id is None:
            continue
        _create(db, p, app_id, res, fallback, now)

    return res



def _ensure_present(db, row, src, dst, p, res, fallback, now) -> None:
    """Keep an already-placed link valid (idempotent).

    The link is valid only while dst points at the *same inode as the
    current source*. This catches: quality upgrades (src replaced -> new
    inode) and any drift. If dst is gone, re-create from the source.
    """
    src_ino = inode_of(src)
    dst_ino = inode_of(dst)
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
                db.commit()
            else:
                res.skipped += 1
                res.errors.append(f"{dst}: {r.error}")
        else:
            db.execute("UPDATE links SET status='stale' WHERE id=?", (row["id"],))
            db.commit()
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
                    "UPDATE links SET inode=?, src_path=?, missing_strikes=0 "
                    "WHERE id=?",
                    (inode_of(dst), src, row["id"]),
                )
                db.commit()
            else:
                res.skipped += 1
                res.errors.append(f"{dst}: {r2.error}")
        return

    # already correct; keep stored metadata in sync
    if dst_ino != row["inode"] or src != row["src_path"]:
        db.execute(
            "UPDATE links SET inode=?, src_path=?, missing_strikes=0 WHERE id=?",
            (dst_ino, src, row["id"]),
        )
        db.commit()


def _retire(db, row, src, dst, live_srcs, unlink_on_mismatch, res, now,
            delete_after, fallback) -> None:
    """Remove (or defer) a link that is no longer planned."""
    rule = db.query_one("SELECT * FROM rules WHERE id=?", (row["rule_id"] or 0,))
    rule_unlink = bool(rule["unlink_on_mismatch"]) if rule else unlink_on_mismatch
    src_exists = src in live_srcs and inode_of(src) is not None

    if not src_exists:
        # source gone: grace period before we treat it as deleted
        strikes = (row["missing_strikes"] or 0) + 1
        if row["status"] == "active" and strikes < delete_after:
            db.execute(
                "UPDATE links SET missing_strikes=? WHERE id=?",
                (strikes, row["id"]),
            )
            db.commit()
            return
    elif not rule_unlink:
        # source still there but rule no longer matches; user opted out of
        # auto-unlink -> keep it (mark stale so the UI can show it)
        db.execute("UPDATE links SET status='stale' WHERE id=?", (row["id"],))
        db.commit()
        return

    r = remove_link(dst)
    if r.ok:
        res.removed += 1
    else:
        res.errors.append(f"remove {dst}: {r.error}")
    db.execute("UPDATE links SET status='missing' WHERE id=?", (row["id"],))
    db.commit()


def _create(db, p: PlannedLink, app_id: int, res, fallback, now) -> None:
    """Create one planned link (idempotent)."""
    parent = os.path.dirname(p.dst_path)
    if not ensure_dir(parent):
        res.skipped += 1
        res.errors.append(f"{p.dst_path}: cannot create parent dir {parent}")
        return
    r = create_link(p.src_path, p.dst_path, fallback)
    if r.ok:
        res.created += 1
        db.execute(
            "INSERT INTO links (rule_id, app_id, item_id, file_id, src_path, "
            "dst_path, inode, status, created_at, missing_strikes, match_key) "
            "VALUES (?,?,?,?,?,?,?, 'active', ?, 0, ?) "
            "ON CONFLICT (rule_id, item_id, file_id, match_key) DO UPDATE SET "
            "dst_path=excluded.dst_path, src_path=excluded.src_path, "
            "inode=excluded.inode, status='active', created_at=excluded.created_at, "
            "missing_strikes=0",
            (p.rule_id, app_id, p.item_id, p.file_id, p.src_path, p.dst_path,
             inode_of(p.dst_path), now, p.match_key),
        )
        db.commit()
    else:
        res.skipped += 1
        res.errors.append(f"{p.dst_path}: {r.error}")
