# ArrLink

Tag-based **hardlink** manager for **Radarr** and **Sonarr**. Connect your
apps, import their tags, map tags to destination path/filename templates,
and ArrLink continuously hardlinks matching media into organized folders —
reacting to new imports and tag changes.

> M4 done: poller, diff, and hardlinker — new imports and tag changes are
> hardlinked automatically. See `PLAN.md` for the full design and remaining
> milestones (M5 Sonarr → M7).

## Features (through M1)

- Multi-stage Docker image (Node 22 → Python 3.12-slim), `PUID`/`PGID`
  (starts as root to chown volumes, drops to `PUID`/`PGID` via gosu),
  healthcheck
- **Auth (M1)**
  - Generic **OIDC** (Auth Code + PKCE, **confidential client**): provider
    discovery, code exchange, `state`/`nonce` validation, group/email
    allow-lists (union; empty = anyone signed in)
  - **Auto-login**: no in-app auth screen — if the browser already has a
    provider session the OIDC round-trip is instant
  - **Silent refresh**: 12 h local sessions; a background sweeper refreshes
    them via the stored provider refresh token (provider token rotation
    supported); rejected refreshes drop the session, which the SPA handles by
    re-triggering the instant round-trip
  - `none` / `password` fallback modes
  - All data endpoints 401 without a session; `/api/health` stays open for
    the container healthcheck
- **Apps (M2)**
  - Radarr adapter: **Test connection** (pre-save + per-app), **live tag
    import** from `GET /v3/tag`, item fetching from `GET /v3/movie`
    (normalization for M4's diff engine), per-app `last_error` surfaced in UI
  - Sonarr is a valid type but returns 422 until M5
  - Tags page with usage counts + "used by N rules" (true matcher match,
    disabled rules excluded)
- Vite + React + TypeScript + Tailwind SPA (dark theme)
  - Auth gate (auto-login redirect, error surfaces, header user + sign out)
  - Dashboard (health, auth, connected apps)
  - Apps (Radarr/Sonarr CRUD, API keys masked, Test + Import tags actions)
  - Tags (per-app vocabulary, import, rule usage)
  - Rules (matcher + dir/filename template CRUD, validation, tag
    autocomplete from imported tags, **live preview** — see below)
  - Logs (event history)
  - Settings (runtime JSON key/value store + OIDC allow-list editor)
- **Poller + hardlinker (M4)**
  - per-app async poller (30 s ±20 % jitter, exponential backoff on errors,
    manual **rescan** button)
  - diff engine: new items/files, tag changes, **renames** (inode-tracked →
    link re-created under the new name), **quality upgrades** (inode swap →
    re-linked), deletions with a **3-miss grace** so re-imports don't lose
    links
  - hardlinks via `os.link` with **inode-verified idempotency** (safe across
    restarts); a foreign file at the destination is never clobbered
    (skipped + logged)
  - **unlink-on-mismatch** (default on, per-rule toggle + global override)
  - cross-filesystem fallback: `skip` (default) / `copy` / `symlink`
    (`FS_FALLBACK`)
  - Links page (browse/filter/remove/**repair**), live SSE log stream, link
    counts on the dashboard
  - safety: source files are never touched; only entries ArrLink created are
    removed, and only after inode verification
- **Rules engine (M3)**
  - Matching: exact / list / regex (named + positional capture groups)
  - Templates: dir + optional filename with placeholders `{$tag}` `{$app}`
    `{$title}` `{$year}` `{$1..9}` `{$<group>}` `{$basename}` `{$stem}` `{$ext}`
    — sanitized (illegal chars, `..`, 100-char cap), jailed to an allowed
    root (default `/linked`, overridable via Settings `allowed_roots`), and
    the source file extension is never dropped
  - **Live preview** (`POST /api/rules/preview?app_id=`): dry-runs the rule
    over the app's current items and shows exactly which files would land
    where — nothing is created until the M4 poller runs
- FastAPI JSON API + SSE placeholder
- SQLite (WAL) with versioned forward-only migrations (v1: core, v2: OIDC);
  thread-local connections

## Layout

```
backend/arrlink/     FastAPI app
  api/               auth, apps, tags, rules, logs, settings, health
  arr/               base.py (contract), radarr.py, factory.py (M5: sonarr)
  core/              matching, template, planner, poller, linker, fsutil
  auth/              oidc.py (discovery/PKCE/refresh), sessions.py (sweep)
  state.py           SQLite (WAL) + migrations
  config.py          env settings (pydantic-settings)
  main.py            app factory + auth-sweep lifespan + SPA static serving
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
# the poller starts automatically; rescan an app from the UI or:
#   curl -X POST http://localhost:8270/api/apps/1/rescan

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

### OIDC setup (M1)

1. In your provider (e.g. authentik) create an **application** +
   **provider** (OpenID Connect). In the application settings use the
   **client** tab to get the **client id** and **client secret**
   (confidential client).
2. Redirect URI: `http(s)://<host>:8270/api/auth/oidc/callback`
3. Set `AUTH_MODE=oidc`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
   `OIDC_CLIENT_SECRET` in the compose file.
4. (Optional) restrict access: Settings → Access control → allowed groups
   and/or emails (empty = any authenticated user).

> The **id_token is decoded but not signature-verified** (claims are read
> from the userinfo endpoint over TLS; id_token is used for nonce/exp only).
> This keeps the client dependency-free and works with any standard provider.

## Milestones

| # | Scope | Status |
|---|---|---|
| M0 | scaffold, Docker, SPA shell, API/state foundation | ✅ done |
| M1 | OIDC auth (PKCE, confidential client, silent refresh, allow-lists) | ✅ done |
| M2 | Radarr adapter: ping, tag import | ✅ done |
| M3 | rule matching, templates, live preview | ✅ done |
| M4 | poller, diff engine, hardlinker (Radarr) | ✅ done |
| M5 | Sonarr adapter (series + episode tags) | next |
| M6 | unlink lifecycle, repair, presets, fs fallback | |
| M7 | docs, image publish, homelab test matrix | |
