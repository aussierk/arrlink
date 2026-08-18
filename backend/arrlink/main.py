"""ArrLink FastAPI app: JSON API + built SPA (Vite/React/TS)."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
from .api import (
    apps,
    auth,
    backup as backup_api,
    health,
    links as links_api,
    logs,
    presets as presets_api,
    rules,
    settings as settings_api,
    tags,
    vocabulary as vocabulary_api,
)
from .auth import sessions as sess_mod
from .auth.oidc import OidcClient
from .config import effective_auth, get_settings, setup_logging
from .core import backup as backup_core
from .core.poller import Poller
from .core.template import audit_rule_roots
from .singleton import InstanceLockError, acquire_instance_lock, release_instance_lock
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
        if not auth["oidc_enabled"]:
            continue
        try:

            def _factory(auth=auth):
                return OidcClient(
                    auth["oidc_issuer"],
                    auth["oidc_client_id"],
                    auth["oidc_client_secret"] or "",
                )

            stats = await asyncio.to_thread(sess_mod.run_sweep, db, _factory, auth["session_ttl_h"])
            if stats["failed"]:
                db.log_event(
                    "warn",
                    f"auth sweep: {stats['failed']} session(s) dropped, "
                    f"{stats['refreshed']} refreshed",
                )
        except Exception as e:  # noqa: BLE001 - never crash the app
            log.warning("auth sweep error: %s", e)


async def _backup_loop(db: State, settings) -> None:
    """Background loop: nightly DB backup with retention (PLAN.md SS7/SS11)."""
    if not settings.backup_enabled:
        return
    while True:
        try:
            age = backup_core.newest_backup_age_s(settings.backup_dir)
            if age is None or age > backup_core.STALE_S:
                await asyncio.to_thread(
                    backup_core.run_backup_cycle,
                    db,
                    settings.db_path,
                    settings.backup_dir,
                    settings.backup_retention_days,
                )
        except Exception as e:  # noqa: BLE001 - never crash the app
            log.warning("backup loop error: %s", e)
        await asyncio.sleep(backup_core.CHECK_INTERVAL_S)


def create_app(db_path: Path | None = None) -> FastAPI:
    """Build the app. `db_path` overrides the default (used by tests)."""
    settings = get_settings()
    setup_logging(settings.log_level)
    resolved_db_path = db_path or settings.db_path
    # Acquired before State() so the migration step itself is also
    # protected from a concurrent racer, and so a conflict fails as early/loudly as possible.
    try:
        lock_path = acquire_instance_lock(resolved_db_path.parent)
    except InstanceLockError:
        log.error("startup aborted: instance lock already held")
        raise
    db = State(resolved_db_path)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        task = asyncio.create_task(_auth_sweep(db, settings))
        task_backup = asyncio.create_task(_backup_loop(db, settings))
        poller = Poller(db, settings)
        app.state.poller = poller
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
            if task_backup:
                task_backup.cancel()
            release_instance_lock(lock_path)

    app = FastAPI(title="ArrLink", version=__version__, lifespan=lifespan)
    app.state.settings = settings
    app.state.db = db

    # Opt-in Host-header allow-list (TRUSTED_HOSTS env) -- unset by default,
    if settings.trusted_hosts:
        hosts = [h.strip() for h in settings.trusted_hosts.split(",") if h.strip()]
        for loopback in ("127.0.0.1", "localhost", "::1"):
            if loopback not in hosts:
                hosts.append(loopback)
        if hosts:
            app.add_middleware(TrustedHostMiddleware, allowed_hosts=hosts)

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
    app.include_router(backup_api.router)
    app.include_router(apps.router)
    app.include_router(links_api.router)
    app.include_router(tags.router)
    app.include_router(rules.router)
    app.include_router(logs.router)
    app.include_router(settings_api.router)
    app.include_router(presets_api.router)
    app.include_router(vocabulary_api.router)

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
