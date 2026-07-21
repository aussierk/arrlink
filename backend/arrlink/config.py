"""Application settings (env-driven) and logging setup."""
from __future__ import annotations

import logging
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger(__name__)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    port: int = 8270
    # Defaults to ./config for local dev; the container entrypoint sets
    # CONFIG_DIR=/config.
    config_dir: Path = Path("config")
    log_level: str = "info"
    fs_fallback: str = "skip"  # skip | copy | symlink (cross-device links)

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
