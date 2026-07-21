"""Links API: browse created hardlinks, delete one, repair missing ones."""
from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from ..core.fsutil import create_link, ensure_dir, inode_of
from ..deps import get_db
from ..state import State
from .auth import CurrentUser

router = APIRouter(prefix="/api/links", tags=["links"])


@router.get("")
def list_links(
    _user: CurrentUser,
    db: State = Depends(get_db),
    app_id: int | None = None,
    rule_id: int | None = None,
    status: str | None = Query(default="active"),
    limit: int = Query(default=500, ge=1, le=5000),
) -> list[dict]:
    sql = (
        "SELECT l.*, r.name AS rule_name, a.name AS app_name, a.type AS app_type "
        "FROM links l LEFT JOIN rules r ON r.id=l.rule_id "
        "LEFT JOIN apps a ON a.id=l.app_id WHERE 1=1"
    )
    params: list = []
    if app_id is not None:
        sql += " AND l.app_id=?"
        params.append(app_id)
    if rule_id is not None:
        sql += " AND l.rule_id=?"
        params.append(rule_id)
    if status:
        sql += " AND l.status=?"
        params.append(status)
    sql += " ORDER BY l.id DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in db.query(sql, tuple(params))]


@router.delete("/{link_id}", status_code=204)
def delete_link(link_id: int, _user: CurrentUser, db: State = Depends(get_db)) -> None:
    from ..core.fsutil import remove_link

    row = db.query_one("SELECT * FROM links WHERE id=?", (link_id,))
    if not row:
        raise HTTPException(404, "link not found")
    r = remove_link(row["dst_path"])
    if not r.ok and r.error:
        raise HTTPException(500, r.error)
    db.execute("UPDATE links SET status='missing' WHERE id=?", (link_id,))
    db.commit()
    db.log_event("info", f"link removed: {row['dst_path']}")


@router.post("/repair")
def repair(
    request: Request,
    _user: CurrentUser,
    db: State = Depends(get_db),
) -> dict:
    """Re-create active links whose dst disappeared but whose source survives."""
    fixed = 0
    failed = 0
    fallback = str(request.app.state.settings.fs_fallback)
    # 'missing' too: repair re-creates links that were removed (by the UI or
    # by the poller) whose source file has since (re)appeared.
    rows = db.query("SELECT * FROM links WHERE status IN ('active','stale','missing')")
    for row in rows:
        dst = row["dst_path"]
        src = row["src_path"]
        if inode_of(dst) is not None:
            continue
        if inode_of(src) is None:
            continue
        ensure_dir(os.path.dirname(dst))
        r = create_link(src, dst, fallback)
        if r.ok:
            fixed += 1
            db.execute(
                "UPDATE links SET status='active', inode=?, missing_strikes=0 "
                "WHERE id=?",
                (inode_of(dst), row["id"]),
            )
        else:
            failed += 1
    db.commit()
    if fixed:
        db.log_event("info", f"repair: re-created {fixed} link(s)")
    return {"fixed": fixed, "failed": failed}
