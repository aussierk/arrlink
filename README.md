# ArrLink

Tag-based **hardlink** manager for **Radarr** and **Sonarr**. Connect your
apps, import their tags, map tags to destination path/filename templates,
and ArrLink continuously hardlinks matching media into organized folders —
reacting to new imports and tag changes.

> M0 scaffold: repo, Docker build, TypeScript SPA, FastAPI + SQLite
> foundation. See `PLAN.md` for the full design and remaining milestones
> (M1 OIDC auth → M7).

## Features (M0)

- Multi-stage Docker image (Node 22 → Python 3.12-slim), `PUID`/`PGID`
  (starts as root to chown volumes, drops to `PUID`/`PGID` via gosu),
  healthcheck
- Vite + React + TypeScript + Tailwind SPA (dark theme)
  - Dashboard (health, auth mode, connected apps)
  - Apps (Radarr/Sonarr CRUD, API keys masked in responses)
  - Rules (matcher + dir/filename template CRUD, validation)
  - Logs (event history)
  - Settings (runtime JSON key/value store)
- FastAPI JSON API + SSE placeholder
- SQLite (WAL) with versioned forward-only migrations; thread-local
  connections

## Layout

```
backend/arrlink/     FastAPI app
  api/               apps, tags, rules, logs, settings, health
  state.py           SQLite (WAL) + migrations
  config.py          env settings (pydantic-settings)
  main.py            app factory + SPA static serving
web/                 Vite + React + TS SPA
tests/               pytest suite
compose.yaml         deployment example
Dockerfile           multi-stage build
```

## Develop

```sh
# backend
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest tests/ -q
CONFIG_DIR=./config .venv/bin/python -m uvicorn arrlink.main:app --app-dir backend --port 8270 --reload

# frontend (proxies /api to :8270)
cd web && npm install
npm run dev        # http://localhost:5173
```

## Run (Docker)

```sh
cp .env.example .env   # optional
docker compose build
docker compose up -d
# UI: http://<host>:8270
```

## Milestones

| # | Scope | Status |
|---|---|---|
| M0 | scaffold, Docker, SPA shell, API/state foundation | ✅ done |
| M1 | OIDC auth (PKCE, confidential client, silent refresh, allow-lists) | next |
| M2 | Radarr adapter: ping, tag import | |
| M3 | rule matching, templates, live preview | |
| M4 | poller, diff engine, hardlinker (Radarr) | |
| M5 | Sonarr adapter (series + episode tags) | |
| M6 | unlink lifecycle, repair, presets, fs fallback | |
| M7 | docs, image publish, homelab test matrix | |
