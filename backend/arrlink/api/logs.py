"""Event log endpoints (M3 adds the SSE live stream)."""
from __future__ import annotations

import time

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse

from ..deps import get_db
from ..state import State
from .auth import CurrentUser

router = APIRouter(prefix="/api", tags=["logs"])


@router.get("/logs")
def list_logs(
    _user: CurrentUser,
    level: str | None = None,
    app_id: int | None = None,
    limit: int = Query(default=100, ge=1, le=1000),
    db: State = Depends(get_db),
) -> list[dict]:
    sql = "SELECT * FROM events"
    where: list[str] = []
    params: list = []
    if level:
        where.append("level=?")
        params.append(level)
    if app_id is not None:
        where.append("app_id=?")
        params.append(app_id)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in db.query(sql, tuple(params))]


@router.get("/logs/stream")
def logs_stream(_user: CurrentUser) -> StreamingResponse:
    """Placeholder SSE endpoint — the real live feed lands with M3."""

    def generate():
        while True:
            time.sleep(15)
            yield ": keep-alive\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")
