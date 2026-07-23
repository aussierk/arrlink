"""Runtime settings (JSON key/value in SQLite; group/email allow-lists etc. live here)."""
from __future__ import annotations

import json
import re

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..config import AUTH_MODES, effective_auth
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


class AuthSettingsIn(BaseModel):
    auth_mode: str
    auto_login: bool = True
    # Blank secret fields = keep the current value (the UI can't recover them).
    ui_password: str = ""
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: str = ""
    oidc_redirect_uri: str | None = None  # None = unchanged; "" = clear (auto)


def _auth_view(db: State, env) -> dict:
    """Masked view of the effective auth config (no secrets returned)."""
    auth = effective_auth(db, env)
    return {
        "auth_mode": auth["auth_mode"],
        "auto_login": bool(auth["auto_login"]),
        "ui_password_set": bool(auth["ui_password"]),
        "oidc_issuer": auth["oidc_issuer"] or "",
        "oidc_client_id": auth["oidc_client_id"] or "",
        "oidc_client_secret_set": bool(auth["oidc_client_secret"]),
        "oidc_redirect_uri": auth["oidc_redirect_uri"] or "",
        "auth_modes": list(AUTH_MODES),
    }


@router.get("/auth")
def get_auth(
    request: Request, _user: CurrentUser, db: State = Depends(get_db)
) -> dict:
    return _auth_view(db, request.app.state.settings)


@router.put("/auth")
def put_auth(
    body: AuthSettingsIn,
    request: Request,
    _user: CurrentUser,
    db: State = Depends(get_db),
) -> dict:
    env = request.app.state.settings
    if body.auth_mode not in AUTH_MODES:
        raise HTTPException(422, f"auth_mode must be one of {list(AUTH_MODES)}")
    # Validate against the EFFECTIVE (post-save) values so we never allow saving
    # a mode that would immediately lock everyone out.
    eff_pw = body.ui_password or db.get_setting("auth_password") or env.ui_password or ""
    eff_issuer = (
        body.oidc_issuer or db.get_setting("oidc_issuer") or env.oidc_issuer or ""
    )
    eff_cid = (
        body.oidc_client_id
        or db.get_setting("oidc_client_id")
        or env.oidc_client_id
        or ""
    )
    if body.auth_mode == "password" and not eff_pw:
        raise HTTPException(
            422, "a UI password is required when auth mode is password"
        )
    if body.auth_mode == "oidc" and not (eff_issuer and eff_cid):
        raise HTTPException(
            422, "OIDC issuer and client ID are required when auth mode is oidc"
        )
    db.set_setting("auth_mode", body.auth_mode)
    db.set_setting("oidc_auto_login", body.auto_login)
    if body.ui_password:
        db.set_setting("auth_password", body.ui_password)
    if body.oidc_issuer:
        db.set_setting("oidc_issuer", body.oidc_issuer)
    if body.oidc_client_id:
        db.set_setting("oidc_client_id", body.oidc_client_id)
    if body.oidc_client_secret:
        db.set_setting("oidc_client_secret", body.oidc_client_secret)
    if body.oidc_redirect_uri is not None:
        if body.oidc_redirect_uri:
            db.set_setting("oidc_redirect_uri", body.oidc_redirect_uri)
        else:
            db.delete_setting("oidc_redirect_uri")
    db.log_event("info", f"auth settings updated (mode={body.auth_mode})")
    return _auth_view(db, env)


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
