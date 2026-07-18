"""Tags per app (M2: live import from the app's API; manual import kept for
testing/offline use)."""
from __future__ import annotations

import asyncio
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..arr.base import AdapterError
from ..arr.factory import get_adapter
from ..deps import get_db
from ..state import State, now
from .auth import CurrentUser

router = APIRouter(prefix="/api", tags=["tags"])


class TagImportIn(BaseModel):
    labels: list[str] = Field(min_length=1, max_length=500)
    counts: dict[str, int] = {}


def _rule_matches_label(rule, label: str) -> bool:
    """Does this rule's matcher match this exact tag label?"""
    mt = rule["match_type"]
    mv = rule["match_value"]
    if mt == "exact":
        return mv.strip() == label
    if mt == "list":
        return label in [s.strip() for s in mv.split(",") if s.strip()]
    if mt == "regex":
        try:
            return re.search(mv, label) is not None
        except re.error:
            return False
    return False


@router.get("/apps/{app_id}/tags")
def list_tags(
    app_id: int, _user: CurrentUser, db: State = Depends(get_db)
) -> list[dict]:
    if not db.query_one("SELECT id FROM apps WHERE id=?", (app_id,)):
        raise HTTPException(404, "app not found")
    tags = db.query("SELECT * FROM tags WHERE app_id=? ORDER BY label", (app_id,))
    rules = db.query(
        "SELECT * FROM rules WHERE enabled=1 AND (app_scope IS NULL OR app_scope=?)",
        (app_id,),
    )
    out = []
    for t in tags:
        d = dict(t)
        d["rule_count"] = sum(1 for r in rules if _rule_matches_label(r, t["label"]))
        out.append(d)
    return out


@router.post("/apps/{app_id}/tags/import", status_code=201)
def import_tags(
    app_id: int,
    _user: CurrentUser,
    db: State = Depends(get_db),
) -> dict:
    """Fetch the app's tag vocabulary live and store it."""
    row = db.query_one("SELECT * FROM apps WHERE id=?", (app_id,))
    if not row:
        raise HTTPException(404, "app not found")
    try:
        adapter = get_adapter(row["type"], row["url"], row["api_key"])
        tags = asyncio.run(adapter.fetch_tags())
    except (ValueError, AdapterError) as e:
        detail = getattr(e, "detail", None) or str(e)
        db.execute("UPDATE apps SET last_error=? WHERE id=?", (detail, app_id))
        db.commit()
        db.log_event("warn", f"tag import failed for {row['name']}: {detail}", app_id)
        raise HTTPException(502, detail) from e

    ts = now()
    for tag in tags:
        db.execute(
            "INSERT INTO tags (app_id, label, count, imported_at) VALUES (?,?,?,?) "
            "ON CONFLICT (app_id, label) DO UPDATE SET "
            "count=excluded.count, imported_at=excluded.imported_at",
            (app_id, tag.label, tag.count, ts),
        )
    db.commit()
    db.execute("UPDATE apps SET last_error=NULL WHERE id=?", (app_id,))
    db.commit()
    db.log_event(
        "info",
        f"imported {len(tags)} tag(s) from {row['name']}",
        app_id,
    )
    return {"imported": len(tags)}


@router.post("/apps/{app_id}/tags/import-manual", status_code=201)
def import_tags_manual(
    app_id: int,
    body: TagImportIn,
    _user: CurrentUser,
    db: State = Depends(get_db),
) -> dict:
    """Offline/manual import (used by tests; not needed in normal operation)."""
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
