"""Event log endpoints + SSE live stream."""

from __future__ import annotations

import asyncio
import json
from typing import Literal

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..deps import get_db
from ..state import State
from .auth import CurrentUser

router = APIRouter(prefix="/api", tags=["logs"])


class ClientErrorIn(BaseModel):
    """A JS exception reported by the SPA (error boundary or a global
    window.onerror / unhandledrejection handler)."""

    message: str = Field(min_length=1, max_length=500)
    level: Literal["error", "warn", "info"] = "error"
    url: str = Field(default="", max_length=300)
    stack: str = Field(default="", max_length=2000)


@router.post("/logs", status_code=204)
def report_client_error(
    _user: CurrentUser,
    body: ClientErrorIn,
    db: State = Depends(get_db),
) -> None:
    """Record a frontend exception in the event log so it shows up on the
    Logs page and the live stream, same as any backend event."""
    msg = f"[web] {body.message}"
    if body.url:
        msg += f" @ {body.url}"
    if body.stack:
        msg += f" | {body.stack.splitlines()[0]}"
    db.log_event(body.level, msg[:1000])


@router.get("/logs")
def list_logs(
    _user: CurrentUser,
    level: str | None = None,
    app_id: int | None = None,
    rule_id: int | None = None,
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
    if rule_id is not None:
        where.append("rule_id=?")
        params.append(rule_id)
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in db.query(sql, tuple(params))]


@router.get("/logs/stream")
async def logs_stream(
    _user: CurrentUser,
    db: State = Depends(get_db),
    limit: int | None = Query(default=None, ge=0),
) -> StreamingResponse:
    """Live SSE feed: initial 50 events, then new ones as they happen.

    `limit` makes it a bounded snapshot stream (yields up to `limit` events
    then closes) — useful for tests. Omitted = infinite live stream.
    """

    async def generate():
        total = 0
        rows = db.query("SELECT * FROM events ORDER BY id DESC LIMIT 50")
        last_id = 0
        for r in reversed(rows):
            last_id = r["id"]
            yield f"id: {r['id']}\ndata: {json.dumps(dict(r))}\n\n"
            total += 1
            if limit is not None and total >= limit:
                return
        if limit is not None:
            return
        while True:
            await asyncio.sleep(3)
            new = db.query("SELECT * FROM events WHERE id>? ORDER BY id", (last_id,))
            if new:
                for r in new:
                    last_id = r["id"]
                    yield f"id: {r['id']}\ndata: {json.dumps(dict(r))}\n\n"
            else:
                yield ": keep-alive\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")
