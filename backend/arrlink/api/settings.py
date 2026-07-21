"""Runtime settings (JSON key/value in SQLite; group/email allow-lists etc. live here)."""
from __future__ import annotations

import json
import re

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..deps import get_db
from ..state import State
from .auth import CurrentUser

router = APIRouter(prefix="/api/settings", tags=["settings"])

_KEY_RE = re.compile(r"^[a-z0-9_.-]{1,64}$")


class SettingValue(BaseModel):
    value: object


@router.get("")
def get_all(_user: CurrentUser, db: State = Depends(get_db)) -> dict:
    return db.all_settings()


@router.get("/effective")
def effective(
    request: Request, _user: CurrentUser, db: State = Depends(get_db)
) -> dict:
    """The resolved runtime values the poller/repairer actually use.

    Env/env-derived defaults where nothing is set in the settings store — so
    the Settings UI can pre-fill and edit exactly what takes effect.
    """
    from ..config import FS_FALLBACK_MODES
    from ..core.fsutil import resolve_fs_fallback
    from ..core.template import DEFAULT_ROOTS

    env = request.app.state.settings
    return {
        "global_unlink_on_mismatch": bool(
            db.get_setting("global_unlink_on_mismatch", True)
        ),
        "fs_fallback": resolve_fs_fallback(db, env.fs_fallback),
        "fs_fallback_modes": list(FS_FALLBACK_MODES),
        "allowed_roots": db.get_setting("allowed_roots") or list(DEFAULT_ROOTS),
    }


@router.put("/{key}")
def set_setting(
    key: str, body: SettingValue, _user: CurrentUser, db: State = Depends(get_db)
) -> dict:
    if not _KEY_RE.match(key):
        raise HTTPException(422, "invalid setting key")
    try:
        json.dumps(body.value)
    except (TypeError, ValueError) as e:
        raise HTTPException(422, "value must be JSON-serializable") from e
    db.set_setting(key, body.value)
    return db.all_settings()


@router.delete("/{key}", status_code=204)
def delete_setting(
    key: str, _user: CurrentUser, db: State = Depends(get_db)
) -> None:
    db.delete_setting(key)
