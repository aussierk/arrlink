# ArrLink

Tag-based **hardlink** manager for **Radarr** and **Sonarr**. Connect your
apps, import their tags, map tags to destination path/filename templates,
and ArrLink continuously hardlinks matching media into organized folders —
reacting to new imports and tag changes.

> M6 done: Radarr + Sonarr connect, poll, and hardlink, with presets, a
> Settings page (unlink / fs-fallback / allowed roots), and the full
> unlink/rename/replace lifecycle. See `PLAN.md` for the design and remaining
> milestone (M7).

## Features

- Multi-stage Docker image (Node 22 → Python 3.12-slim), `PUID`/`PGID`
  (starts as root to chown volumes, drops to `PUID`/`PGID` via gosu),
  healthcheck
- **Auth (M1, dual-mode in M10)**
  - **Password** and **OIDC** login are independent — either, both, or
    neither can be enabled, and the login page offers whichever are active
  - Generic **OIDC** (Auth Code + PKCE, **confidential client**): provider
    discovery, code exchange, `state`/`nonce` validation, group/email
    allow-lists (union; empty = anyone signed in)
  - **Auto-login**: when OIDC is enabled, `/login` redirects straight to the
    provider on load (instant when the browser already has a provider
    session) — visit `/login?form=true` to skip that and reach the manual
    sign-in form/SSO-button chooser instead (e.g. to use password login even
    with auto-login on)
  - **Silent refresh**: 12 h local sessions; a background sweeper refreshes
    them via the stored provider refresh token (provider token rotation
    supported); rejected refreshes drop the session, which the SPA handles by
    re-triggering the instant round-trip
  - Password login: **Argon2id**-hashed at rest (via `argon2-cffi`), opaque
    session token (not the password) is what the cookie actually holds
  - Open mode (both disabled, default): no login at all — LAN-only assumption
  - All data endpoints 401 without a session; `/api/health` stays open for
    the container healthcheck
- **Apps (M2)**
  - Radarr adapter: **Test connection** (pre-save + per-app), **live tag
    import** from `GET /v3/tag`, item fetching from `GET /v3/movie`
    (normalization for the diff engine), per-app `last_error` surfaced in UI
  - **Sonarr adapter (M5)**: `GET /v3/series` + per-series
    `GET /v3/episodefile` joined by `seriesId`; series-level tags; files
    stat'ed for inodes. Both adapters translate the apps' tag **ids** (the
    wire format) to **labels** via `GET /v3/tag` so rules match real tags
  - Tags page with usage counts + "used by N rules" (true matcher match,
    disabled rules excluded)
- Vite + React + TypeScript + Tailwind SPA (dark theme)
  - Dedicated `/login` page (password form and/or SSO button, whichever are
    enabled; OIDC auto-login redirect with the `?form=true` manual-chooser
    escape hatch; error surfaces), header user + sign out
  - Dashboard (health, auth, connected apps, and the **Links** panel —
    browse/filter/remove/**repair**)
  - Apps (create **and edit** Radarr/Sonarr connections — name, URL, API key,
    poll interval, enabled; Test + Import tags + rescan)
  - Tags (**tag repository** — a curated shared tag list that can be pushed to
    the apps; plus per-app vocabulary import with usage counts)
  - Rules (create/edit rules in a modal with **preset quick-start**, live
    preview, tag autocomplete)
  - Logs (event history, live SSE feed)
  - Settings (structured, no raw JSON: **Linking** — unlink-on-mismatch,
    cross-filesystem fallback, allowed roots; **Access control** — OIDC
    allow-lists)
- **Poller + hardlinker (M4)**
  - per-app async poller (default **300 s** per app, ±20 % jitter,
    exponential backoff on errors, manual **rescan** button)
  - diff engine: new items/files, tag changes, **renames** (inode-tracked →
    link re-created under the new name), **quality upgrades** (inode swap →
    re-linked), deletions with a **3-miss grace** so re-imports don't lose
    links
  - hardlinks via `os.link` with **inode-verified idempotency** (safe across
    restarts); a foreign file at the destination is never clobbered
    (skipped + logged)
  - **unlink-on-mismatch** (default on, per-rule toggle + global override)
  - cross-filesystem fallback: `skip` (default) / `copy` / `symlink`
    (`FS_FALLBACK` env, or the `fs_fallback` Setting which takes precedence)
  - Links panel on the Dashboard (browse/filter/remove/**repair**), live SSE
    log stream, link counts
  - safety: source files are never touched; only entries ArrLink created are
    removed, and only after inode verification
- **Rules engine (M3)**
  - Matching: exact / list / regex (named + positional capture groups)
  - Templates: dir + optional filename with placeholders `{$tag}` `{$app}`
    `{$title}` `{$year}` `{$1..9}` `{$<group>}` `{$basename}` `{$stem}` `{$ext}`
    — sanitized (illegal chars, `..`, 100-char cap), jailed to an allowed
    root (default `/media`, overridable via Settings `allowed_roots`), and
    the source file extension is never dropped
  - **Live preview** (`POST /api/rules/preview?app_id=`): dry-runs the rule
    over the app's current items and shows exactly which files would land
    where — nothing is created until the M4 poller runs
- **Presets + runtime settings (M6)**
  - **Presets**: one-click, editable rules for common conventions — user tags
    (`## - $user` → `{$user}` directly under the base folder),
    certification (`{$tag}` directly under the base folder), kids, 4K/HDR,
    requested. Matchers differ per app type (movie vs TV ratings/kids tags);
    the base folder defaults to `/media/movies` (Radarr) / `/media/tv`
    (Sonarr) but is a parameter, and is jail-validated against the allowed
    roots. Presets are a **quick-start inside the rule modal** (no separate
    page). `GET /api/presets?app_type=` + `POST /api/presets/apply`
  - **Runtime fs fallback**: the cross-filesystem fallback (`skip`/`copy`/
    `symlink`) is a runtime **Setting** (Settings page) that takes precedence
    over the `FS_FALLBACK` env default, applied by both the poller and repair
  - **Settings page**: fully structured (no raw JSON) — a **Linking** section
    edits global unlink-on-mismatch, the fs fallback mode, and the allowed
    roots, plus an **Access control** section for OIDC allow-lists. Backed by
    `GET /api/settings/effective` (the resolved runtime values).
- FastAPI JSON API + SSE live log stream
- SQLite (WAL) with versioned forward-only migrations (v1 core, v2 OIDC,
  v4 tag repository); thread-local connections
- **Path mirroring**: the container must see the *arr apps' media at the same
  absolute paths (mount them read-only). The link root defaults to `/media`
  (mount a writable pool at `/media`, on the same pool as the sources so
  hardlinks work).

## Layout

```
backend/arrlink/     FastAPI app
  api/               auth, apps, tags, rules, presets, logs, settings, health
  arr/               base.py (contract), radarr.py, sonarr.py, factory.py
  core/              matching, template, planner, presets, poller, linker, fsutil
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

### Paths (important)

- **Media must be visible at the same absolute paths the *arr apps use** —
  mount them read-only (e.g. `/mnt/tank/media:/mnt/tank/media:ro`). ArrLink
  `stat`s the source files and hardlinks them, so the paths must line up.
- **Link root defaults to `/media`** (the allowed root). Mount a writable
  pool at `/media` on the **same filesystem** as the sources so hardlinks
  work (otherwise the cross-filesystem fallback kicks in). Presets link under
  `/media/movies` and `/media/tv` by default.
- If you prefer a different root, set the `allowed_roots` Setting (Settings
  → Linking) and use matching base folders in your rules.

### Auth setup (password / OIDC / both — M1, dual-mode in M10)

Password and OIDC login are independent — enable either or both, via `.env`
(seed defaults) and/or Settings → Authentication (runtime overrides, take
effect immediately, no restart).

**Password login**: set `AUTH_PASSWORD_ENABLED=true` and `UI_PASSWORD=...`
(or toggle it on and set a password in Settings → Authentication).
`UI_USERNAME` defaults to `admin` if left unset. The password is hashed at
rest (Argon2id); the session cookie holds an opaque token, not the password
itself.

**OIDC login**:
1. In your provider (e.g. authentik) create an **application** +
   **provider** (OpenID Connect). In the application settings use the
   **client** tab to get the **client id** and **client secret**
   (confidential client).
2. Redirect URI: `http(s)://<host>:8270/api/auth/oidc/callback`
3. Set `AUTH_OIDC_ENABLED=true`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
   `OIDC_CLIENT_SECRET` in the compose file.
4. (Optional) restrict access: Settings → Access control → allowed groups
   and/or emails (empty = any authenticated user).
5. `OIDC_AUTO_LOGIN` (default `true`): `/login` redirects straight to the
   provider when OIDC is enabled. Visit `/login?form=true` to bypass that
   and reach the manual chooser (SSO button and/or the password form) —
   this isn't linked anywhere in the UI, it's a URL you navigate to
   directly when you want to skip auto-login for one visit.

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
| M5 | Sonarr adapter (series + episodefile join, tag-id → label) | ✅ done |
| M6 | presets, runtime fs fallback, Settings page, lifecycle polish | ✅ done |
| M7 | docs, image publish, homelab test matrix | next |
