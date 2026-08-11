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
