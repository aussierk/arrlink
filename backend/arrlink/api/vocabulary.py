"""Vocabulary CRUD/read surface: known values per rule-condition category,
and "refresh now" force-triggers for syncs that otherwise already run
automatically in the background (see core/poller.py, core/vocabulary.py).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from ..core.vocabulary import RICH_CATEGORIES, sync_tmdb_vocabulary, sync_trash_vocabulary
from ..deps import get_db
from ..state import State
from .auth import CurrentUser

router = APIRouter(prefix="/api", tags=["vocabulary"])


@router.get("/vocabulary")
def get_vocabulary(
    _user: CurrentUser,
    category: str = Query(...),
    app_type: str = Query(...),
    app_id: int | None = Query(None),
    db: State = Depends(get_db),
) -> list[dict]:
    """Known values for one (category, app_type[, app_id]) scope: the
    shared vocabulary plus this app's own instance-scoped rows, if any."""
    if category not in RICH_CATEGORIES:
        raise HTTPException(422, f"category must be one of {sorted(RICH_CATEGORIES)}")
    rows = db.query(
        "SELECT value, source, external_id, app_id FROM vocabulary WHERE "
        "category=? AND app_type=? AND (app_id IS NULL OR app_id=?) ORDER BY value",
        (category, app_type, app_id),
    )
    return [dict(r) for r in rows]


@router.post("/vocabulary/import/tmdb")
def import_tmdb(_user: CurrentUser, db: State = Depends(get_db)) -> dict:
    """Force-trigger the same TMDB genre/certification sync that
    Poller._vocabulary_loop already runs automatically on a daily cadence —
    useful right after setting a TMDB key override, not required otherwise."""
    import asyncio

    counts = asyncio.run(sync_tmdb_vocabulary(db))
    if not counts:
        raise HTTPException(
            422,
            "no TMDB API key configured (set one in Settings, or the "
            "operator can configure a default via the TMDB_API_KEY env var)",
        )
    return {"imported": counts}


@router.post("/vocabulary/import/trash")
def import_trash(
    _user: CurrentUser,
    app_type: str = Query(...),
    db: State = Depends(get_db),
) -> dict:
    """Force-trigger the TRaSH Guides quality-naming sync for one app type."""
    import asyncio

    if app_type not in ("radarr", "sonarr"):
        raise HTTPException(422, "app_type must be 'radarr' or 'sonarr'")
    n = asyncio.run(sync_trash_vocabulary(db, app_type))
    return {"imported": n}


@router.post("/apps/{app_id}/vocabulary/sync")
def sync_app_vocabulary(app_id: int, _user: CurrentUser, db: State = Depends(get_db)) -> dict:
    """Force-trigger this app's per-instance vocabulary sync (quality
    profiles, languages, observed collection names) — Poller already runs
    this automatically every poll; this is just for immediate feedback."""
    import asyncio

    from ..arr.base import AdapterError
    from ..arr.factory import get_adapter
    from ..core.poller import Poller

    row = db.query_one("SELECT * FROM apps WHERE id=?", (app_id,))
    if not row:
        raise HTTPException(404, "app not found")
    try:
        adapter = get_adapter(row["type"], row["url"], row["api_key"])
        items = asyncio.run(adapter.fetch_items())
    except (ValueError, AdapterError) as e:
        detail = getattr(e, "detail", None) or str(e)
        raise HTTPException(502, detail) from e
    # Reuse Poller's instance-sync logic without needing an active Poller
    # instance/event loop — it only touches `self.db`.
    poller = Poller.__new__(Poller)
    poller.db = db
    poller._sync_instance_vocabulary(app_id, row["type"], items)
    return {"ok": True}
