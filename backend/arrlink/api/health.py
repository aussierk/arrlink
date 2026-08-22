"""Health endpoint (used by the container HEALTHCHECK)."""

from __future__ import annotations

from fastapi import APIRouter, Depends

from .. import __version__
from ..deps import get_db
from ..state import State

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
def health(db: State = Depends(get_db)) -> dict:
    db_ok = True
    version = None
    try:
        row = db.query_one("SELECT version FROM schema_version LIMIT 1")
        version = row["version"] if row else None
    except Exception:  # pragma: no cover - defensive
        db_ok = False
    return {
        "status": "ok" if db_ok else "degraded",
        "version": __version__,
        "schema_version": version,
        "db": "ok" if db_ok else "error",
    }
