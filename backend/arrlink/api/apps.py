"""Apps CRUD: storage, connection tests, and tag import."""
from __future__ import annotations

import sqlite3
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from ..deps import get_db
from ..state import State
from .auth import CurrentUser

router = APIRouter(prefix="/api/apps", tags=["apps"])

AppType = Literal["radarr", "sonarr"]


class AppIn(BaseModel):
    name: str = Field(min_length=1, max_length=50)
    type: AppType
    url: str = Field(min_length=4, max_length=200)
    api_key: str = Field(min_length=1, max_length=200)
    enabled: bool = True
    poll_interval_s: int = Field(default=30, ge=10, le=600)

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
    if not db.query_one("SELECT id FROM apps WHERE id=?", (app_id,)):
        raise HTTPException(404, "app not found")
    db.execute(
        "UPDATE apps SET name=?, type=?, url=?, api_key=?, enabled=?, "
        "poll_interval_s=? WHERE id=?",
        (
            body.name,
            body.type,
            body.url,
            body.api_key,
            int(body.enabled),
            body.poll_interval_s,
            app_id,
        ),
    )
    db.commit()
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


@router.post("/{app_id}/rescan")
def rescan(
    app_id: int, _user: CurrentUser, db: State = Depends(get_db)
) -> dict:
    """Stub — manual rescan is implemented with the poller in M4."""
    row = db.query_one("SELECT name FROM apps WHERE id=?", (app_id,))
    if not row:
        raise HTTPException(404, "app not found")
    return {"status": "stub", "note": "rescan arrives in M4"}
