"""Application settings (env-driven) and logging setup."""
from __future__ import annotations

import logging
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger(__name__)


# Cross-filesystem fallback modes for the hardlinker (fsutil.create_link).
FS_FALLBACK_MODES = ("skip", "copy", "symlink")


def normalize_fs_fallback(value, default: str = "skip") -> str:
    """Coerce a raw fs-fallback value (env or Setting) to a valid mode."""
    v = (value or "").strip().lower()
    return v if v in FS_FALLBACK_MODES else default


# Auth modes (M1). The mode and credentials are env-seeded but can be
# overridden at runtime via Settings (Settings -> Authentication).
AUTH_MODES = ("none", "password", "oidc")


def effective_auth(db, env) -> dict:
    """Resolve the runtime auth configuration."""
    s = db if db is not None else None
    get = (lambda k: s.get_setting(k)) if s is not None else (lambda k: None)

    mode = (get("auth_mode") or env.auth_mode or "none").strip().lower()
    if mode not in AUTH_MODES:
        mode = "none"

    # auto_login is env-only (default True); a runtime Setting may override.
    auto_login = get("oidc_auto_login")
    auto_login = bool(auto_login) if auto_login is not None else True

    return {
        "auth_mode": mode,
        "auto_login": auto_login,
        "ui_password": get("auth_password") or env.ui_password or "",
        "oidc_issuer": get("oidc_issuer") or env.oidc_issuer or "",
        "oidc_client_id": get("oidc_client_id") or env.oidc_client_id or "",
        "oidc_client_secret": get("oidc_client_secret") or env.oidc_client_secret or "",
        "oidc_redirect_uri": get("oidc_redirect_uri") or env.oidc_redirect_uri or "",
        "session_ttl_h": env.session_ttl_h,
    }


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    port: int = 8270
    # Defaults to ./config for local dev; the container entrypoint sets
    # CONFIG_DIR=/config.
    config_dir: Path = Path("config")
    log_level: str = "info"
    # Default for the cross-filesystem fallback (skip | copy | symlink). A
    # runtime value can be set via the `fs_fallback` Setting (Settings page);
    # it takes precedence over this env value and is normalized on use.
    fs_fallback: str = "skip"

    # Auth (M1 wires up the full OIDC flow)
    auth_mode: str = "none"  # none | password | oidc
    ui_password: str | None = None
    oidc_issuer: str | None = None
    oidc_client_id: str | None = None
    oidc_client_secret: str | None = None
    oidc_redirect_uri: str | None = None  # default: <origin>/api/auth/oidc/callback
    session_ttl_h: int = 12

    @property
    def db_path(self) -> Path:
        return self.config_dir / "arrlink.db"


def get_settings() -> Settings:
    return Settings()


def setup_logging(level: str) -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )
