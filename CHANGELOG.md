# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/), and this project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-01

Initial release. ArrLink connects to Radarr and Sonarr, matches items by
tag, and continuously hardlinks them into organized folders as tags and
libraries change.

### Highlights

- **Rule engine**: tag-based matching (exact/list/regex) → directory +
  filename templates with placeholders, jailed to an allowed root. Live
  preview shows exactly what a rule would link before it runs. Presets
  give a one-click starting point for common conventions (user tags,
  certification, kids, 4K/HDR).
- **Poller + hardlink engine**: safe, idempotent hardlinking with
  inode-verified writes -- handles renames and quality-upgrade replacements
  automatically, never touches source files, and cleans up after itself
  (unlink-on-mismatch) when a rule stops matching.
- **Auth**: password and OIDC login, independently enabled, with
  group/email allow-lists, silent session refresh, and lockout after
  repeated failed password attempts.
- **Settings**, fully structured (no raw JSON) across General, Services,
  Authentication, Vocabulary, and Backup -- including application
  identity, localization, live-editable logging, and automatic database
  backup with configurable interval/retention.
- **Dashboard**: connected-app health, a links panel with search/repair,
  and a live event log.
- Multi-stage Docker image, `PUID`/`PGID` support, CI, and a release
  workflow publishing to `ghcr.io/aussierk/arrlink`.

See the [README](README.md) for the full feature list and setup guide.

[Unreleased]: https://github.com/aussierk/arrlink/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/aussierk/arrlink/releases/tag/v0.1.0