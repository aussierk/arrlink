"""DB backup endpoints: list existing backups, trigger one manually."""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from ..core import backup as backup_core
from ..deps import get_db
from ..state import State
from .auth import CurrentUser

router = APIRouter(prefix="/api/backup", tags=["backup"])


@router.get("")
def list_backups(_user: CurrentUser, request: Request) -> list[dict]:
    settings = request.app.state.settings
    return backup_core.list_backups(settings.backup_dir)


@router.get("/settings")
def get_backup_settings(_user: CurrentUser, request: Request, db: State = Depends(get_db)) -> dict:
    enabled, retention_days, interval_hours = backup_core.effective_backup_settings(
        db, request.app.state.settings
    )
    return {"enabled": enabled, "retention_days": retention_days, "interval_hours": interval_hours}


class BackupSettingsIn(BaseModel):
    enabled: bool
    retention_days: int
    interval_hours: int


@router.put("/settings")
def put_backup_settings(
    body: BackupSettingsIn,
    _user: CurrentUser,
    db: State = Depends(get_db),
) -> dict:
    db.set_setting("backup_enabled", body.enabled)
    db.set_setting("backup_retention_days", body.retention_days)
    db.set_setting("backup_interval_hours", body.interval_hours)
    db.log_event(
        "info",
        f"backup settings updated (enabled={body.enabled}, "
        f"retention_days={body.retention_days}, interval_hours={body.interval_hours})",
    )
    return {
        "enabled": body.enabled,
        "retention_days": body.retention_days,
        "interval_hours": body.interval_hours,
    }


@router.post("/run")
async def run_backup(_user: CurrentUser, request: Request, db: State = Depends(get_db)) -> dict:
    settings = request.app.state.settings
    _enabled, retention_days, _interval_hours = backup_core.effective_backup_settings(db, settings)
    # Manual trigger always runs regardless of `enabled` -- that flag only
    # gates the automatic nightly loop; a manual "run now" is an explicit
    # admin action and should always be honored.
    return await asyncio.to_thread(
        backup_core.run_backup_cycle,
        db,
        settings.db_path,
        settings.backup_dir,
        retention_days,
    )
