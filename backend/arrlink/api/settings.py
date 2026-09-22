"""Runtime settings (JSON key/value in SQLite; group/email allow-lists etc. live here)."""

from __future__ import annotations

import json
import re

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..auth import lockout
from ..auth.passwords import hash_password
from ..config import effective_auth
from ..deps import get_db
from ..state import State
from .auth import CurrentUser

router = APIRouter(prefix="/api/settings", tags=["settings"])

_KEY_RE = re.compile(r"^[a-z0-9_.-]{1,64}$")

# Keys owned by a dedicated endpoint (PUT /auth, PUT /tmdb) with its own
# validation (viable-auth-method checks, hashing) and audit logging. The
# generic PUT/DELETE /{key} below must never touch these directly -- doing
# so would let any authenticated caller write an unhashed/unvalidated
# auth_password (or flip auth_*_enabled) with no log_event trail, bypassing
# every safeguard put_auth() enforces.
_PROTECTED_SETTING_KEYS = frozenset(
    {
        "auth_password",
        "auth_password_enabled",
        "auth_oidc_enabled",
        "oidc_auto_login",
        "auth_username",
        "oidc_issuer",
        "oidc_client_id",
        "oidc_client_secret",
        "tmdb_api_key",
        "log_level",
        "log_size_limit_mb",
    }
)


class SettingValue(BaseModel):
    value: object


@router.get("")
def get_all(_user: CurrentUser, db: State = Depends(get_db)) -> dict:
    return db.all_settings()


@router.get("/effective")
def effective(request: Request, _user: CurrentUser, db: State = Depends(get_db)) -> dict:
    """The resolved runtime values the poller/repairer/General settings page actually use."""
    from ..config import FS_FALLBACK_MODES, effective_app_url
    from ..core.fsutil import resolve_fs_fallback
    from ..core.template import DEFAULT_ROOTS

    env = request.app.state.settings
    return {
        "global_unlink_on_mismatch": bool(db.get_setting("global_unlink_on_mismatch", True)),
        "fs_fallback": resolve_fs_fallback(db, env.fs_fallback),
        "fs_fallback_modes": list(FS_FALLBACK_MODES),
        "allowed_roots": db.get_setting("allowed_roots") or list(DEFAULT_ROOTS),
        "app_title": db.get_setting("app_title") or "ArrLink",
        "app_url": effective_app_url(db, env),
        "display_language": db.get_setting("display_language") or "en",
        "display_timezone": db.get_setting("display_timezone") or "UTC",
        "bind_address": "0.0.0.0",
        "port": env.port,
    }


class AuthSettingsIn(BaseModel):
    password_enabled: bool = False
    oidc_enabled: bool = False
    auto_login: bool = True
    # Not a secret, but follows the same "blank = keep current" convention
    # as the rest of these fields (default "admin" if never set at all).
    ui_username: str = ""
    # Blank secret fields = keep the current value (the UI can't recover them).
    ui_password: str = ""
    oidc_issuer: str = ""
    oidc_client_id: str = ""
    oidc_client_secret: str = ""


def _auth_view(db: State, env) -> dict:
    """Masked view of the effective auth config (no secrets returned)."""
    auth = effective_auth(db, env)
    st = lockout.status(db, (auth["ui_username"] or "admin").strip().lower())
    return {
        "password_enabled": auth["password_enabled"],
        "oidc_enabled": auth["oidc_enabled"],
        "auto_login": bool(auth["auto_login"]),
        "ui_username": auth["ui_username"],
        "ui_password_set": bool(auth["ui_password"]),
        "password_locked": st.locked,
        "password_locked_until": st.locked_until,
        "oidc_issuer": auth["oidc_issuer"] or "",
        "oidc_client_id": auth["oidc_client_id"] or "",
        "oidc_client_secret_set": bool(auth["oidc_client_secret"]),
    }


@router.get("/auth")
def get_auth(request: Request, _user: CurrentUser, db: State = Depends(get_db)) -> dict:
    return _auth_view(db, request.app.state.settings)


@router.put("/auth")
def put_auth(
    body: AuthSettingsIn,
    request: Request,
    _user: CurrentUser,
    db: State = Depends(get_db),
) -> dict:
    env = request.app.state.settings
    # Validate against the EFFECTIVE (post-save) values so we never allow saving
    # a flag combination that would immediately lock everyone out. Password and
    # OIDC are independent -- both, one, or neither may be enabled.
    eff_pw = body.ui_password or db.get_setting("auth_password") or env.ui_password or ""
    eff_issuer = body.oidc_issuer or db.get_setting("oidc_issuer") or env.oidc_issuer or ""
    eff_cid = body.oidc_client_id or db.get_setting("oidc_client_id") or env.oidc_client_id or ""
    if body.password_enabled and not eff_pw:
        raise HTTPException(422, "a UI password is required to enable password login")
    if body.oidc_enabled and not (eff_issuer and eff_cid):
        raise HTTPException(422, "OIDC issuer and client ID are required to enable OIDC login")
    db.set_setting("auth_password_enabled", body.password_enabled)
    db.set_setting("auth_oidc_enabled", body.oidc_enabled)
    db.set_setting("oidc_auto_login", body.auto_login)
    if body.ui_username:
        db.set_setting("auth_username", body.ui_username)
    if body.ui_password:
        db.set_setting("auth_password", hash_password(body.ui_password))
    if body.oidc_issuer:
        db.set_setting("oidc_issuer", body.oidc_issuer)
    if body.oidc_client_id:
        db.set_setting("oidc_client_id", body.oidc_client_id)
    if body.oidc_client_secret:
        db.set_setting("oidc_client_secret", body.oidc_client_secret)
    db.log_event(
        "info",
        f"auth settings updated (password={body.password_enabled}, oidc={body.oidc_enabled})",
    )
    return _auth_view(db, env)


class TmdbSettingsIn(BaseModel):
    # Blank = keep the current value (mirrors oidc_client_secret above) --
    # never required, ArrLink falls back to the operator-configured default
    # (TMDB_API_KEY env var) when neither is set. See core/vocabulary.py.
    api_key: str = ""


@router.get("/tmdb")
def get_tmdb(_user: CurrentUser, db: State = Depends(get_db)) -> dict:
    from ..core.vocabulary import DEFAULT_TMDB_API_KEY

    return {
        "api_key_set": bool((db.get_setting("tmdb_api_key") or "").strip()),
        "default_key_configured": bool(DEFAULT_TMDB_API_KEY),
    }


@router.put("/tmdb")
def put_tmdb(body: TmdbSettingsIn, _user: CurrentUser, db: State = Depends(get_db)) -> dict:
    if body.api_key:
        db.set_setting("tmdb_api_key", body.api_key)
    return get_tmdb(_user, db)


_VALID_LOG_LEVELS = frozenset({"debug", "info", "warning", "error"})
_LOG_SIZE_MB_MIN = 1
_LOG_SIZE_MB_MAX = 1000


@router.get("/logging")
def get_logging(request: Request, _user: CurrentUser, db: State = Depends(get_db)) -> dict:
    from ..config import effective_logging_settings

    level, size_mb = effective_logging_settings(db, request.app.state.settings)
    return {"log_level": level, "log_size_limit_mb": size_mb}


class LoggingSettingsIn(BaseModel):
    log_level: str
    log_size_limit_mb: int


@router.put("/logging")
def put_logging(
    body: LoggingSettingsIn,
    request: Request,
    _user: CurrentUser,
    db: State = Depends(get_db),
) -> dict:
    from ..config import apply_logging_settings

    level = body.log_level.lower()
    if level not in _VALID_LOG_LEVELS:
        raise HTTPException(422, f"log_level must be one of {sorted(_VALID_LOG_LEVELS)}")
    if not (_LOG_SIZE_MB_MIN <= body.log_size_limit_mb <= _LOG_SIZE_MB_MAX):
        raise HTTPException(
            422, f"log_size_limit_mb must be between {_LOG_SIZE_MB_MIN} and {_LOG_SIZE_MB_MAX}"
        )
    db.set_setting("log_level", level)
    db.set_setting("log_size_limit_mb", body.log_size_limit_mb)
    # Live-apply immediately -- storing the Setting alone would leave the
    # running root logger/file handler stale until next restart.
    apply_logging_settings(level, body.log_size_limit_mb, request.app.state.settings.log_path)
    db.log_event(
        "info", f"logging settings updated (level={level}, size_mb={body.log_size_limit_mb})"
    )
    return {"log_level": level, "log_size_limit_mb": body.log_size_limit_mb}


@router.put("/{key}")
def set_setting(
    key: str, body: SettingValue, _user: CurrentUser, db: State = Depends(get_db)
) -> dict:
    if not _KEY_RE.match(key):
        raise HTTPException(422, "invalid setting key")
    if key in _PROTECTED_SETTING_KEYS:
        raise HTTPException(403, f"{key!r} must be changed via its dedicated settings endpoint")
    try:
        json.dumps(body.value)
    except (TypeError, ValueError) as e:
        raise HTTPException(422, "value must be JSON-serializable") from e
    db.set_setting(key, body.value)
    db.log_event("info", f"setting updated: {key}")
    return db.all_settings()


@router.delete("/{key}", status_code=204)
def delete_setting(key: str, _user: CurrentUser, db: State = Depends(get_db)) -> None:
    if key in _PROTECTED_SETTING_KEYS:
        raise HTTPException(403, f"{key!r} must be changed via its dedicated settings endpoint")
    db.delete_setting(key)
    db.log_event("info", f"setting deleted: {key}")
