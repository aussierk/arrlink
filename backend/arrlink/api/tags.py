"""Tags per app (M0: manual import so the UI is exercisable; M2: live fetch)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..deps import get_db
from ..state import State, now
from .auth import CurrentUser

router = APIRouter(prefix="/api", tags=["tags"])


class TagImportIn(BaseModel):
    labels: list[str] = Field(min_length=1, max_length=500)
    counts: dict[str, int] = {}


@router.get("/apps/{app_id}/tags")
def list_tags(
    app_id: int, _user: CurrentUser, db: State = Depends(get_db)
) -> list[dict]:
    if not db.query_one("SELECT id FROM apps WHERE id=?", (app_id,)):
        raise HTTPException(404, "app not found")
    return [
        dict(r)
        for r in db.query(
            "SELECT * FROM tags WHERE app_id=? ORDER BY label", (app_id,)
        )
    ]


@router.post("/apps/{app_id}/tags/import", status_code=201)
def import_tags(
    app_id: int,
    body: TagImportIn,
    _user: CurrentUser,
    db: State = Depends(get_db),
) -> dict:
    """M0 accepts a manual label list; M2 replaces this with a live API fetch."""
    if not db.query_one("SELECT id FROM apps WHERE id=?", (app_id,)):
        raise HTTPException(404, "app not found")
    ts = now()
    for label in body.labels:
        label = label.strip()
        if not label:
            continue
        db.execute(
            "INSERT INTO tags (app_id, label, count, imported_at) VALUES (?,?,?,?) "
            "ON CONFLICT (app_id, label) DO UPDATE SET "
            "count=excluded.count, imported_at=excluded.imported_at",
            (app_id, label, body.counts.get(label, 0), ts),
        )
    db.commit()
    db.log_event("info", f"imported {len(body.labels)} tag(s) for app {app_id}", app_id)
    return {"imported": len(body.labels)}
