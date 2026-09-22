# Features

Full detail behind the summary in the [README](../README.md).

## Platform

- Multi-stage Docker image (Node 22 → Python 3.12-slim), `PUID`/`PGID`
  (starts as root to chown volumes, drops to `PUID`/`PGID` via gosu),
  healthcheck
- FastAPI JSON API + SSE live log stream
- SQLite (WAL), single versioned schema baseline; thread-local connections

## Auth

- **Password** and **OIDC** login are independent -- either, both, or neither
  can be enabled, and the login page offers whichever are active
- Generic **OIDC** (Auth Code + PKCE, **confidential client**): provider
  discovery, code exchange, `state`/`nonce` validation, group/email
  allow-lists (union; empty = anyone signed in)
- **Auto-login**: when OIDC is enabled, `/login` redirects straight to the
  provider on load (instant when the browser already has a provider
  session) -- visit `/login?form=true` to skip that and reach the manual
  sign-in form/SSO-button chooser instead (e.g. to use password login even
  with auto-login on)
- **Silent refresh**: 12 h local sessions; a background sweeper refreshes
  them via the stored provider refresh token (provider token rotation
  supported); rejected refreshes drop the session, which the SPA handles by
  re-triggering the instant round-trip
- Password login: **Argon2id**-hashed at rest (via `argon2-cffi`), opaque
  session token (not the password) is what the cookie actually holds
- Open mode (both disabled, default): no login at all -- LAN-only assumption
- All data endpoints 401 without a session; `/api/health` stays open for
  the container healthcheck

## Apps

- Radarr adapter: **Test connection** (pre-save + per-app), **live tag
  import** from `GET /v3/tag`, item fetching from `GET /v3/movie`
  (normalization for the diff engine), per-app `last_error` surfaced in UI
- **Sonarr adapter**: `GET /v3/series` + per-series `GET /v3/episodefile`
  joined by `seriesId`; series-level tags; files stat'ed for inodes. Both
  adapters translate the apps' tag **ids** (the wire format) to **labels**
  via `GET /v3/tag` so rules match real tags
- Tags page with usage counts + "used by N rules" (true matcher match,
  disabled rules excluded)

## Rules engine

- Matching: exact / list / regex (named + positional capture groups),
  conditions combined with AND/OR
- Templates: dir + optional filename with placeholders `{$tag}` `{$app}`
  `{$title}` `{$year}` `{$1..9}` `{$<group>}` `{$basename}` `{$stem}` `{$ext}`
  -- sanitized (illegal chars, `..`, 100-char cap), jailed to an allowed
  root (default `/media`, overridable via Settings `allowed_roots`), and
  the source file extension is never dropped
- **Live preview** (`POST /api/rules/preview?app_id=`): dry-runs the rule
  over the app's current items and shows exactly which files would land
  where -- nothing is created until the poller runs

## Poller + hardlinker

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

## Presets + runtime settings

- **Presets**: one-click, editable rules for common conventions -- user tags
  (`## - $user` → `{$user}` directly under the base folder), certification
  (`{$tag}` directly under the base folder), kids, 4K/HDR, requested.
  Matchers differ per app type (movie vs TV ratings/kids tags); the base
  folder defaults to `/media/movies` (Radarr) / `/media/tv` (Sonarr) but is
  a parameter, and is jail-validated against the allowed roots. Presets are
  a **quick-start inside the rule modal** (no separate page).
  `GET /api/presets?app_type=` + `POST /api/presets/apply`
- **Runtime fs fallback**: the cross-filesystem fallback (`skip`/`copy`/
  `symlink`) is a runtime **Setting** (Settings → General) that takes
  precedence over the `FS_FALLBACK` env default, applied by both the poller
  and repair.

## Web UI

Vite + React + TypeScript + Tailwind SPA (dark theme).

- Dedicated `/login` page (password form and/or SSO button, whichever are
  enabled; OIDC auto-login redirect with the `?form=true` manual-chooser
  escape hatch; error surfaces), header user + sign out
- Dashboard (health, auth, connected apps, and the **Links** panel --
  browse/filter/remove/**repair**)
- Apps (create **and edit** Radarr/Sonarr connections -- name, URL, API key,
  poll interval, enabled; Test + Import tags + rescan)
- Tags (per-app tag vocabulary import, usage counts, and per-tag category
  classification)
- Rules (create/edit rules in a modal with **preset quick-start**, live
  preview, tag autocomplete)
- Logs (event history, live SSE feed)
- Settings (structured, no raw JSON), across five tabs:
  - **General**: Application title/URL, display language, region (TMDB
    certification country), timezone (one display timezone for every
    viewer), a read-only bind address/port display, logging (level +
    rotating log-file size limit, both live), and linking behavior
    (unlink-on-mismatch, cross-filesystem fallback, allowed roots)
  - **Services**: Radarr/Sonarr connections
  - **Authentication**: password/OIDC config and the OIDC allowed-groups/
    allowed-emails allow-lists
  - **Vocabulary**: TMDB/TRaSH Guides overrides and per-app sync
  - **Backup**: list/run-now, and the automatic backup's
    enabled/interval/retention

## Layout

```
backend/arrlink/     FastAPI app
  api/               auth, apps, tags, rules, presets, logs, settings, health
  arr/               base.py (contract), radarr.py, sonarr.py, factory.py
  core/              matching, template, planner, presets, poller, linker, fsutil
  auth/              oidc.py (discovery/PKCE/refresh), sessions.py (sweep)
  state.py           SQLite (WAL) + schema
  config.py          env settings (pydantic-settings)
  main.py            app factory + auth-sweep lifespan + SPA static serving
web/                 Vite + React + TS SPA
tests/               pytest suite
compose.yaml         deployment example
Dockerfile           multi-stage build
```