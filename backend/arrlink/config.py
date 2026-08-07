"""Application settings (env-driven) and logging setup."""
from __future__ import annotations

import logging
from functools import cached_property
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

from .auth.passwords import hash_password

log = logging.getLogger(__name__)


# Cross-filesystem fallback modes for the hardlinker (fsutil.create_link).
FS_FALLBACK_MODES = ("skip", "copy", "symlink")


def normalize_fs_fallback(value, default: str = "skip") -> str:
    """Coerce a raw fs-fallback value (env or Setting) to a valid mode."""
    v = (value or "").strip().lower()
    return v if v in FS_FALLBACK_MODES else default


def effective_auth(db, env) -> dict:
    """Resolve the runtime auth configuration."""
    s = db if db is not None else None
    get = (lambda k: s.get_setting(k)) if s is not None else (lambda k: None)

    db_password_enabled = get("auth_password_enabled")
    password_enabled = (
        bool(db_password_enabled) if db_password_enabled is not None else env.auth_password_enabled
    )
    db_oidc_enabled = get("auth_oidc_enabled")
    oidc_enabled = bool(db_oidc_enabled) if db_oidc_enabled is not None else env.auth_oidc_enabled

    # auto_login: env-seeded (default True), a runtime Setting may override.
    auto_login = get("oidc_auto_login")
    auto_login = bool(auto_login) if auto_login is not None else env.oidc_auto_login

    return {
        "password_enabled": password_enabled,
        "oidc_enabled": oidc_enabled,
        "auto_login": auto_login,
        "ui_username": get("auth_username") or env.ui_username or "admin",
        # Always an Argon2id hash (or "") — never plaintext. A Setting-stored
        # password is hashed at write time (api/settings.py); an env-seeded
        # UI_PASSWORD is hashed once here (env.ui_password_hash is cached).
        "ui_password": get("auth_password") or env.ui_password_hash or "",
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

    # Auth: password and OIDC login are independent — either, both, or
    # neither may be enabled at once (see effective_auth() in this module).
    auth_password_enabled: bool = False
    auth_oidc_enabled: bool = False
    oidc_auto_login: bool = True
    ui_username: str = "admin"
    ui_password: str | None = None
    oidc_issuer: str | None = None
    oidc_client_id: str | None = None
    oidc_client_secret: str | None = None
    oidc_redirect_uri: str | None = None  # default: <origin>/api/auth/oidc/callback
    session_ttl_h: int = 12
    # Comma-separated hostnames this app is allowed to think it's being
    # reached as (e.g. "arrlink.example.com,192.168.1.50"). Unset (default)
    # = no restriction, same as before this existed. When OIDC is enabled
    # and oidc_redirect_uri isn't pinned, the redirect_uri sent to the
    # provider is derived from the request's own Host header -- setting
    # this closes that off from a spoofed Host on a directly-exposed
    # deployment (see main.py, which adds TrustedHostMiddleware only when
    # this is set).
    trusted_hosts: str | None = None

    @cached_property
    def ui_password_hash(self) -> str:
        """`ui_password`, hashed once (cached — this is a real Argon2id cost,
        not something to redo per request). "" when unset."""
        return hash_password(self.ui_password) if self.ui_password else ""

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
