"""ArrLink FastAPI app: JSON API + built SPA (Vite/React/TS)."""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .api import apps, health, logs, rules, settings as settings_api, tags
from .config import get_settings, setup_logging
from .state import State

log = logging.getLogger(__name__)


def find_dist(here: Path) -> Path | None:
    """Locate the built SPA bundle relative to the main module.

    Repo layout:  <root>/backend/arrlink/main.py  +  <root>/web/dist
    Image layout: /app/arrlink/main.py            +  /app/web/dist
    """
    for parent in (here.parents[2], here.parents[1]):
        cand = parent / "web" / "dist"
        if (cand / "index.html").is_file():
            return cand
    return None


def create_app(db_path: Path | None = None) -> FastAPI:
    """Build the app. `db_path` overrides the default (used by tests)."""
    settings = get_settings()
    setup_logging(settings.log_level)

    app = FastAPI(title="ArrLink", version=__version__)
    app.state.settings = settings
    app.state.db = State(db_path or settings.db_path)

    # Permissive CORS only for the Vite dev server (:5173) during development.
    # In production the SPA is served from the same origin, so this is inert.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(GZipMiddleware, minimum_size=1024)

    app.include_router(health.router)
    app.include_router(apps.router)
    app.include_router(tags.router)
    app.include_router(rules.router)
    app.include_router(logs.router)
    app.include_router(settings_api.router)

    @app.get("/api/auth/me")
    def auth_me() -> dict:
        # M1: OIDC session check. M0: report the configured auth mode.
        return {"authenticated": False, "auth_mode": settings.auth_mode}

    dist = find_dist(Path(__file__).resolve())
    if dist:
        if (dist / "assets").exists():
            app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):  # noqa: ANN202
            full = (dist / path).resolve()
            if full.is_file() and full.is_relative_to(dist):
                return FileResponse(full)
            return FileResponse(dist / "index.html")

    return app


app = create_app()
