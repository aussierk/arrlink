"""DB backup endpoints: list existing backups, trigger one manually.

The automatic nightly job lives in main.py's `_backup_loop`/core/backup.py;
this router is the minimum surface needed to make that job verifiable by an
admin (list + trigger), not a backup-management UI.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, Request

from ..core import backup as backup_core
from ..deps import get_db
from ..state import State
from .auth import CurrentUser

router = APIRouter(prefix="/api/backup", tags=["backup"])


@router.get("")
def list_backups(_user: CurrentUser, request: Request) -> list[dict]:
    settings = request.app.state.settings
    return backup_core.list_backups(settings.backup_dir)


@router.post("/run")
async def run_backup(
    _user: CurrentUser, request: Request, db: State = Depends(get_db)
) -> dict:
    settings = request.app.state.settings
    return await asyncio.to_thread(
        backup_core.run_backup_cycle,
        db,
        settings.db_path,
        settings.backup_dir,
        settings.backup_retention_days,
    )
