"""Apps CRUD: storage, connection tests, and tag import."""
from __future__ import annotations

import asyncio
import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from ..arr.base import AdapterError
from ..arr.factory import get_adapter
from ..deps import get_db
from ..state import State
from .auth import CurrentUser

router = APIRouter(prefix="/api/apps", tags=["apps"])

AppType = Literal["radarr", "sonarr"]


class AppIn(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    type: AppType
    url: str = Field(min_length=4, max_length=200)
    # Blank on update = keep the existing key (the UI sends the masked key
    # which is not a real key). Required to be non-empty on create.
    api_key: str = Field(default="", max_length=200)
    enabled: bool = True
    poll_interval_s: int = Field(default=300, ge=10, le=3600)

    @field_validator("url")
    @classmethod
    def _normalize_url(cls, v: str) -> str:
        v = v.strip()
        if not v.startswith(("http://", "https://")):
            v = "http://" + v
        return v.rstrip("/")


def _app_out(row: sqlite3.Row) -> dict:
    d = dict(row)
    key = d.pop("api_key", "") or ""
    d["api_key_masked"] = ("••••" + key[-4:]) if len(key) > 4 else "••••"
    d["enabled"] = bool(d["enabled"])
    return d


@router.get("")
def list_apps(_user: CurrentUser, db: State = Depends(get_db)) -> list[dict]:
    return [_app_out(r) for r in db.query("SELECT * FROM apps ORDER BY id")]


@router.get("/summary")
def summary(_user: CurrentUser, db: State = Depends(get_db)) -> dict:
    """Aggregate link counts for the dashboard (must precede /{app_id})."""
    from ..core.template import audit_rule_roots

    active = db.query_one("SELECT COUNT(*) c FROM links WHERE status='active'")
    stale = db.query_one("SELECT COUNT(*) c FROM links WHERE status='stale'")
    return {
        "active_links": active["c"] if active else 0,
        "stale_links": stale["c"] if stale else 0,
        "orphaned_rules": audit_rule_roots(db),
    }


@router.get("/{app_id}")
def get_app(
    app_id: int, _user: CurrentUser, db: State = Depends(get_db)
) -> dict:
    row = db.query_one("SELECT * FROM apps WHERE id=?", (app_id,))
    if not row:
        raise HTTPException(404, "app not found")
    return _app_out(row)


@router.post("", status_code=201)
def create_app(
    body: AppIn, _user: CurrentUser, db: State = Depends(get_db)
) -> dict:
    if not body.api_key.strip():
        raise HTTPException(422, "api_key is required to create an app")
    cur = db.execute(
        "INSERT INTO apps (name, type, url, api_key, enabled, poll_interval_s) "
        "VALUES (?,?,?,?,?,?)",
        (
            body.name,
            body.type,
            body.url,
            body.api_key,
            int(body.enabled),
            body.poll_interval_s,
        ),
    )
    db.commit()
    db.log_event("info", f"app added: {body.name} ({body.type})", cur.lastrowid)
    row = db.query_one("SELECT * FROM apps WHERE id=?", (cur.lastrowid,))
    return _app_out(row)


@router.patch("/{app_id}")
def update_app(
    app_id: int, body: AppIn, _user: CurrentUser, db: State = Depends(get_db)
) -> dict:
    row = db.query_one("SELECT * FROM apps WHERE id=?", (app_id,))
    if not row:
        raise HTTPException(404, "app not found")
    # Changing the app type (radarr <-> sonarr) would make the poller treat
    # this as a brand-new app on the next rescan: every existing item stops
    # matching, and after the deletion grace period all of its hardlinks are
    # unlinked from disk. The UI keeps the type fixed on edit; enforce the
    # same here. Allow it only when nothing is linked yet (a harmless config
    # fix, e.g. an app that was added with the wrong type and has no links).
    if body.type != row["type"]:
        linked = db.query_one(
            "SELECT COUNT(*) c FROM links WHERE app_id=? "
            "AND status IN ('active','stale')",
            (app_id,),
        )
        if linked and linked["c"] > 0:
            raise HTTPException(
                422,
                f"cannot change app type from {row['type']} to {body.type}: "
                "this app has linked files, and switching type would unlink "
                "them. Delete the app (removes its links) and add it again "
                f"as {body.type}.",
            )
    # blank api_key = keep the existing one (the UI can't recover the real key)
    api_key = body.api_key.strip() or row["api_key"]
    db.execute(
        "UPDATE apps SET name=?, type=?, url=?, api_key=?, enabled=?, "
        "poll_interval_s=? WHERE id=?",
        (
            body.name,
            body.type,
            body.url,
            api_key,
            int(body.enabled),
            body.poll_interval_s,
            app_id,
        ),
    )
    db.commit()
    db.log_event("info", f"app updated: {body.name}", app_id)
    return _app_out(db.query_one("SELECT * FROM apps WHERE id=?", (app_id,)))


@router.delete("/{app_id}", status_code=204)
def delete_app(
    app_id: int, _user: CurrentUser, db: State = Depends(get_db)
) -> None:
    cur = db.execute("DELETE FROM apps WHERE id=?", (app_id,))
    db.commit()
    if cur.rowcount == 0:
        raise HTTPException(404, "app not found")
    db.log_event("info", f"app deleted: {app_id}")


@router.post("/test")
def test_app(body: AppIn, _user: CurrentUser, db: State = Depends(get_db)) -> dict:
    """Pre-save connection test (used by the add-app dialog)."""
    try:
        adapter = get_adapter(body.type, body.url, body.api_key)
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    try:
        info = asyncio.run(adapter.ping())
    except AdapterError as e:
        raise HTTPException(502, e.detail) from e
    return {"ok": True, "name": info.name, "version": info.version}


@router.post("/{app_id}/test")
def test_app_id(
    app_id: int, _user: CurrentUser, db: State = Depends(get_db)
) -> dict:
    """Re-test an existing app (used by the apps table)."""
    row = db.query_one("SELECT * FROM apps WHERE id=?", (app_id,))
    if not row:
        raise HTTPException(404, "app not found")
    try:
        adapter = get_adapter(row["type"], row["url"], row["api_key"])
    except ValueError as e:
        raise HTTPException(422, str(e)) from e
    try:
        info = asyncio.run(adapter.ping())
    except AdapterError as e:
        db.execute("UPDATE apps SET last_error=? WHERE id=?", (e.detail, app_id))
        db.commit()
        db.log_event("warn", f"connection test failed for {row['name']}: {e.detail}", app_id)
        raise HTTPException(502, e.detail) from e
    db.execute("UPDATE apps SET last_error=NULL WHERE id=?", (app_id,))
    db.commit()
    db.log_event("info", f"connection test ok for {row['name']} ({info.version})", app_id)
    return {"ok": True, "name": info.name, "version": info.version}


@router.post("/{app_id}/rescan")
async def rescan(
    request: Request, app_id: int, _user: CurrentUser, db: State = Depends(get_db)
) -> dict:
    """Manual rescan: poll + reconcile this app now."""
    row = db.query_one("SELECT name FROM apps WHERE id=?", (app_id,))
    if not row:
        raise HTTPException(404, "app not found")
    poller = getattr(request.app.state, "poller", None)
    if poller is None:
        raise HTTPException(503, "poller not running")
    result = await poller.rescan(app_id)
    if not result["ok"]:
        row2 = db.query_one("SELECT last_error FROM apps WHERE id=?", (app_id,))
        err = row2["last_error"] if row2 else None
        raise HTTPException(502, err or "poll failed")
    return result
