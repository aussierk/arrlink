"""Presets API: list preset rules per app type + apply one (creates an editable
rule, jail-validated)."""

from __future__ import annotations

import json

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from ..core import presets as presets_core
from ..core.template import DEFAULT_ROOTS, check_jail
from ..deps import get_db
from ..state import State
from .auth import CurrentUser
from .rules import _scope_app_ids, _trigger_rescan

router = APIRouter(prefix="/api/presets", tags=["presets"])

APP_TYPES = ("radarr", "sonarr")


class PresetApplyIn(BaseModel):
    preset_key: str = Field(min_length=1, max_length=50)
    app_scope: int | None = None  # null = any app
    app_type: str = Field(min_length=1, max_length=20)  # which matcher to use
    base_folder: str | None = Field(default=None, min_length=1, max_length=300)
    name: str | None = Field(default=None, min_length=1, max_length=50)


@router.get("")
def list_presets(
    _user: CurrentUser,
    app_type: str,
    base_folder: str | None = None,
) -> dict:
    if app_type not in APP_TYPES:
        raise HTTPException(422, f"app_type must be one of {list(APP_TYPES)}")
    return {
        "app_type": app_type,
        "base_folder": base_folder or presets_core.default_base_folder(app_type),
        "presets": presets_core.list_presets_for_type(app_type, base_folder),
    }


@router.post("/apply", status_code=201)
def apply_preset(
    body: PresetApplyIn,
    request: Request,
    background_tasks: BackgroundTasks,
    _user: CurrentUser,
    db: State = Depends(get_db),
) -> dict:
    preset = presets_core.get_preset(body.preset_key)
    if preset is None:
        raise HTTPException(422, f"unknown preset: {body.preset_key}")
    if body.app_type not in APP_TYPES:
        raise HTTPException(422, f"app_type must be one of {list(APP_TYPES)}")
    if body.app_scope is not None and not db.query_one(
        "SELECT id FROM apps WHERE id=?", (body.app_scope,)
    ):
        raise HTTPException(422, "app_scope references unknown app")

    base = (body.base_folder or presets_core.default_base_folder(body.app_type)).strip()
    if "\\" in base or not base.startswith("/"):
        raise HTTPException(422, "base_folder must be an absolute path")

    rendered = presets_core.render_preset(body.preset_key, body.app_type, base)
    # Path jail: the base folder must stay under an allowed root. Preset
    # subpaths are placeholder-only (resolve to sanitized, separator-free
    # values), so this guarantees the whole resolved tree stays jailed.
    roots = db.get_setting("allowed_roots") or list(DEFAULT_ROOTS)
    try:
        check_jail(base, roots)
    except Exception as e:  # TemplateError
        raise HTTPException(422, str(e)) from e

    match_type, match_value = preset.matchers[body.app_type]
    name = body.name or f"preset:{preset.key}"
    conditions_json = json.dumps(
        [
            {
                "category": preset.category,
                "match_type": match_type,
                "match_value": match_value,
                "join": None,
            }
        ]
    )
    cur = db.execute(
        "INSERT INTO rules (name, app_scope, conditions_json, "
        "dir_template, filename_template, enabled, unlink_on_mismatch, priority) "
        "VALUES (?,?,?,?, NULL, 1, 1, 100)",
        (name, body.app_scope, conditions_json, rendered["dir_template"]),
    )
    db.commit()
    db.log_event(
        "info",
        f"preset '{preset.key}' applied: rule '{name}' -> {rendered['dir_template']}",
        rule_id=cur.lastrowid,
    )
    rule = db.query_one("SELECT * FROM rules WHERE id=?", (cur.lastrowid,))
    _trigger_rescan(request, background_tasks, _scope_app_ids(body.app_scope, None, db))
    return {
        "preset_key": preset.key,
        "rule": _rule_out(rule),
        "message": f"Created rule '{name}'. Edit it as desired.",
    }


def _rule_out(row) -> dict:
    d = dict(row)
    d["enabled"] = bool(d["enabled"])
    d["unlink_on_mismatch"] = bool(d["unlink_on_mismatch"])
    d["conditions"] = json.loads(d.pop("conditions_json"))
    return d
