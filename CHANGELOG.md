# Changelog

All notable changes to this project are documented here. Starts from this
release forward — not retroactive.

## [Unreleased]

### Added
- Password login lockout (5 failed attempts within 15 minutes locks the
  account for 15 minutes), with a `POST /api/auth/password/unlock`
  escape hatch for an admin with a valid OIDC session.
- Nightly database backup with 7-day retention (`GET /api/backup`,
  `POST /api/backup/run` for manual triggering).
- Cross-process single-instance guard — a second ArrLink process pointed
  at the same config directory now fails fast at startup instead of
  silently running two live pollers against the same Radarr/Sonarr
  instances.
- `LICENSE` (MIT), `SECURITY.md`, CI (backend tests + frontend build on
  every push/PR), and a release workflow publishing versioned images to
  `ghcr.io/aussierk/arrlink` on a `v*` tag push.
- Rule preview can now run against the last poll's stored snapshot (the
  default) instead of a live fetch; a "Refresh from app" button forces a
  live pull. An app that has never polled still falls back to live.
- Links list is paginated (`GET /api/links` returns
  `{items, total, limit, offset}`); the UI gained prev/next controls and a
  "showing X–Y of N" count, so large libraries no longer silently truncate
  at 500 rows.
- `events_retention` setting (default 5000) — the event log is now capped
  by a background prune instead of growing without bound.

### Changed
- **Poller rewritten to scale with changes, not library size.** A no-change
  poll of a large library now issues a single transaction and zero row
  writes, versus one `UPDATE` + `fsync` per item + per file before. On a
  20k-item library the snapshot-diff phase is ~55% faster and the full
  poll+reconcile ~35% faster even on fast storage; on disk-backed SQLite
  the gap is far larger (every eliminated write was its own `fsync`).
- SQLite runs with `synchronous=NORMAL` (WAL-safe) and the poller batches
  each poll into one commit.
- Added indexes on `links(app_id, status)`, `links(file_id)`,
  `links(item_id)`, `links(status)`, and `app_files(item_id, inode)` — the
  reconcile pass no longer full-scans the `links` table every poll.
- Reconcile trusts the source inode captured during the poll instead of
  re-`stat`-ing every source file, and looks rules up once per pass
  instead of once per link.
- Sonarr poll does a delta fetch: `/episodefile` is only re-requested for
  series whose episode-file count / size changed since the last poll
  (tracked via a per-item `stats_fingerprint`), instead of one request per
  series every poll. Per-series file `stat`s moved off the event loop and
  concurrency raised 8 → 16.
- Per-instance quality-profile / language vocabulary is refreshed at most
  every 6 hours rather than on every poll; observed-collection vocabulary
  is only rewritten when it actually changes.
