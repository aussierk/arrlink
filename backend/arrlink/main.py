"""ArrLink FastAPI app: JSON API + built SPA (Vite/React/TS)."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .api import (
    apps,
    auth,
    health,
    links as links_api,
    logs,
    presets as presets_api,
    rules,
    settings as settings_api,
    tags,
)
from .auth import sessions as sess_mod
from .auth.oidc import OidcClient
from .config import effective_auth, get_settings, setup_logging
from .core.poller import Poller
from .core.template import audit_rule_roots
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


async def _auth_sweep(db: State, settings) -> None:
    """Background loop: silently refresh OIDC sessions nearing expiry.

    The auth mode can be switched at runtime (Settings -> Authentication), so
    the loop is always running and re-resolves the effective mode each tick —
    it stays dormant until oidc is active.
    """
    while True:
        await asyncio.sleep(sess_mod.SWEEP_INTERVAL_S)
        auth = effective_auth(db, settings)
        if auth["auth_mode"] != "oidc":
            continue
        try:

            def _factory():
                return OidcClient(
                    auth["oidc_issuer"],
                    auth["oidc_client_id"],
                    auth["oidc_client_secret"] or "",
                )

            stats = await asyncio.to_thread(
                sess_mod.run_sweep, db, _factory, auth["session_ttl_h"]
            )
            if stats["failed"]:
                db.log_event(
                    "warn",
                    f"auth sweep: {stats['failed']} session(s) dropped, "
                    f"{stats['refreshed']} refreshed",
                )
        except Exception as e:  # noqa: BLE001 - never crash the app
            log.warning("auth sweep error: %s", e)


def create_app(db_path: Path | None = None) -> FastAPI:
    """Build the app. `db_path` overrides the default (used by tests)."""
    settings = get_settings()
    setup_logging(settings.log_level)
    db = State(db_path or settings.db_path)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Always run the sweep: the auth mode can be switched to oidc at
        # runtime, and it self-dormants when oidc is not active.
        task = asyncio.create_task(_auth_sweep(db, settings))
        poller = Poller(db, settings)
        app.state.poller = poller
        # Legacy-root audit: enabled rules whose dir template escapes the
        # allowed roots (e.g. /linked/... after a root-default change) would
        # otherwise fail silently per-item. Warn loudly at startup.
        bad_rules = audit_rule_roots(db)
        if bad_rules:
            db.log_event(
                "warn",
                f"rule(s) outside the allowed roots, will not link until fixed: "
                f"{', '.join(bad_rules)} (set allowed_roots or edit the rules)",
            )
        await poller.start()
        try:
            yield
        finally:
            await poller.stop()
            if task:
                task.cancel()

    app = FastAPI(title="ArrLink", version=__version__, lifespan=lifespan)
    app.state.settings = settings
    app.state.db = db

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
    app.include_router(auth.router)
    app.include_router(apps.router)
    app.include_router(links_api.router)
    app.include_router(tags.router)
    app.include_router(rules.router)
    app.include_router(logs.router)
    app.include_router(settings_api.router)
    app.include_router(presets_api.router)

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
