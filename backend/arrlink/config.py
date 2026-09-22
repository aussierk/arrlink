"""Application settings (env-driven) and logging setup."""

from __future__ import annotations

import logging
import logging.handlers
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
        "ui_password": get("auth_password") or env.ui_password_hash or "",
        "oidc_issuer": get("oidc_issuer") or env.oidc_issuer or "",
        "oidc_client_id": get("oidc_client_id") or env.oidc_client_id or "",
        "oidc_client_secret": get("oidc_client_secret") or env.oidc_client_secret or "",
        "session_ttl_h": env.session_ttl_h,
    }


def effective_app_url(db, env) -> str:
    """`app_url`, a runtime Setting overriding the env value (same pattern
    as the fields in effective_auth) -- lets Settings > General edit the
    deployment's external base URL without a redeploy. Used by
    api/auth.py's _redirect_uri() to build the OIDC redirect_uri."""
    s = db if db is not None else None
    db_url = s.get_setting("app_url") if s is not None else None
    return db_url or env.app_url or ""


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    config_dir: Path = Path("config")
    log_level: str = "info"
    fs_fallback: str = "skip"

    # Auth: password and OIDC login are independent -- either, both, or
    # neither may be enabled at once (see effective_auth() in this module).
    auth_password_enabled: bool = False
    auth_oidc_enabled: bool = False
    oidc_auto_login: bool = True
    ui_username: str = "admin"
    ui_password: str | None = None
    oidc_issuer: str | None = None
    oidc_client_id: str | None = None
    oidc_client_secret: str | None = None
    session_ttl_h: int = 12
    # The deployment's external base URL -- scheme + host + optional port +
    # optional sub-path, e.g. "https://arrlink.example.com" or
    # "https://apps.example.com/arrlink". When set, api/auth._redirect_uri()
    # builds the OIDC redirect_uri as APP_URL + "/auth/oidc/callback"; when
    # unset it falls back to the first non-loopback trusted_hosts entry
    # (https), then the spoofable request Host header. A sub-path assumes the
    # reverse proxy strips it before arrlink (no internal sub-path routing).
    app_url: str | None = None
    # Comma-separated hostnames this app is allowed to think it's being
    # reached as (e.g. "arrlink.example.com,192.168.1.50"). Two uses: main.py
    # adds TrustedHostMiddleware when this is set (rejecting a spoofed Host),
    # and api/auth._redirect_uri() derives the OIDC redirect_uri from the
    # first non-loopback entry when app_url isn't set -- static config
    # instead of the spoofable request Host header.
    trusted_hosts: str | None = None
    # Enable permissive CORS for the Vite dev server (:5173). Off by default:
    # in production the SPA is same-origin, and in local dev the Vite proxy
    # (web/vite.config.ts) already makes /api calls same-origin. Set
    # ENABLE_DEV_CORS=1 only when hitting the API cross-origin during dev.
    enable_dev_cors: bool = False
    backup_enabled: bool = True
    backup_retention_days: int = 7
    # Read-only display in Settings > General only -- entrypoint.sh reads
    # $PORT itself (before this Python process even starts) to build the
    # uvicorn --port arg, so changing this field has no live effect; it just
    # lets the running process show the admin what port it's actually on.
    port: int = 8270
    # Env-seed default for the rotating log file's size cap -- a runtime
    # Setting can override this live, see effective_logging_settings().
    log_size_limit_mb: int = 10

    @cached_property
    def ui_password_hash(self) -> str:
        """`ui_password`, hashed once (cached -- this is a real Argon2id cost,
        not something to redo per request). "" when unset."""
        return hash_password(self.ui_password) if self.ui_password else ""

    @property
    def db_path(self) -> Path:
        return self.config_dir / "arrlink.db"

    @property
    def backup_dir(self) -> Path:
        return self.config_dir / "backups"

    @property
    def log_dir(self) -> Path:
        return self.config_dir / "logs"

    @property
    def log_path(self) -> Path:
        return self.log_dir / "arrlink.log"


def get_settings() -> Settings:
    return Settings()


def setup_logging(level: str) -> None:
    """Stdout-only bootstrap, called first (before the DB exists) so Docker
    log visibility is guaranteed even if DB/file-logging setup fails later.
    See apply_logging_settings() for the additive rotating-file handler."""
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )


def effective_logging_settings(db, env) -> tuple[str, int]:
    """(log_level, log_size_limit_mb) -- a runtime Setting overrides the env
    default, same pattern as effective_auth/effective_backup_settings."""
    level = db.get_setting("log_level") or env.log_level
    db_size = db.get_setting("log_size_limit_mb")
    size_mb = int(db_size) if db_size is not None else env.log_size_limit_mb
    return level, size_mb


# Fixed, not user-configurable -- only the level and max size are exposed in
# Settings. Keeping up to 3 rotated-out files alongside the active one caps
# total on-disk log usage at 4x the size limit.
_LOG_BACKUP_COUNT = 3

# Module-level so apply_logging_settings() can reconfigure the same handler
# instance in place on a live PUT instead of adding a duplicate one.
_file_handler: logging.handlers.RotatingFileHandler | None = None


def apply_logging_settings(level: str, max_size_mb: int, log_path: Path | None = None) -> None:
    """Set the root logger's level and add/reconfigure its rotating file handler's size cap."""
    global _file_handler
    root = logging.getLogger()
    lvl = getattr(logging, level.upper(), logging.INFO)
    root.setLevel(lvl)

    needs_new_handler = log_path is not None and (
        _file_handler is None or Path(_file_handler.baseFilename) != log_path
    )
    if needs_new_handler:
        if _file_handler is not None:
            root.removeHandler(_file_handler)
            _file_handler.close()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        _file_handler = logging.handlers.RotatingFileHandler(
            log_path, maxBytes=max_size_mb * 1024 * 1024, backupCount=_LOG_BACKUP_COUNT
        )
        _file_handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s")
        )
        root.addHandler(_file_handler)
    elif _file_handler is None:
        raise ValueError("log_path is required the first time apply_logging_settings runs")
    else:
        _file_handler.maxBytes = max_size_mb * 1024 * 1024
    _file_handler.setLevel(lvl)
