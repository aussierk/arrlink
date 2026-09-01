# Changelog

All notable changes to this project are documented here. The format is based
on [Keep a Changelog](https://keepachangelog.com/), and this project follows
[Semantic Versioning](https://semver.org/).

## [0.2.0](https://github.com/aussierk/arrlink/compare/v0.1.0...v0.2.0) (2026-09-01)


### Features

* **arr:** capture native genre/certification/collection/quality metadata ([f03711d](https://github.com/aussierk/arrlink/commit/f03711db5eb6244fdecbce4cb3da4f6123e38846))
* **auth:** add password login lockout ([579bd20](https://github.com/aussierk/arrlink/commit/579bd206660f15636852f2103689d4f6c4cc64b4))
* **auth:** dedicated login page with dual password + OIDC auth ([9b7e3cf](https://github.com/aussierk/arrlink/commit/9b7e3cfad41da08394a0c4582c0a0c78518424c2))
* **auth:** make auth settings runtime-editable, rework the rule editor ([85e8eb2](https://github.com/aussierk/arrlink/commit/85e8eb23e01cc99890cdde2183ec783a89a8b278))
* **auth:** OIDC client, PKCE flow, and DB-backed sessions ([be24f9d](https://github.com/aussierk/arrlink/commit/be24f9d3a9ff9bcc28c7f928e8e855291723c5ce))
* **auth:** replace OIDC_REDIRECT_URI with APP_URL, move callback to /auth/oidc/callback ([192ce14](https://github.com/aussierk/arrlink/commit/192ce1445b28838103d98d55d5c4692cb1987e3a))
* **auth:** require a session on every data route ([6f15712](https://github.com/aussierk/arrlink/commit/6f15712584608d4b20d6e8bcff685f0db5639da0))
* **backup:** nightly DB backup with 7-day retention ([443cd8c](https://github.com/aussierk/arrlink/commit/443cd8c191f3865e47360212080b802111f92f68))
* **core:** filesystem hardlink/copy primitives (fsutil) ([a6bc8cf](https://github.com/aussierk/arrlink/commit/a6bc8cf460c901bdece153bb92a3a65da4881d0c))
* **dashboard:** warn when auth is fully disabled ([b3672d8](https://github.com/aussierk/arrlink/commit/b3672d88a7b0a7f05ff62cbe3912777f9922431a))
* FastAPI backend with SQLite state and apps/rules/tags/settings/logs API ([5281338](https://github.com/aussierk/arrlink/commit/528133825c3fd7624d97a9c847eed89a026d6ddc))
* **poller:** per-app poller, diff engine, and linker ([467d57a](https://github.com/aussierk/arrlink/commit/467d57a73b65d608bd7dd36e0c02e661bad987f6))
* **radarr:** adapter with connection test and live tag import ([448f9e5](https://github.com/aussierk/arrlink/commit/448f9e5b77f9c27d313b611bf39fe2b97c7e57e4))
* **rules:** matching engine and dir/filename template engine ([1621c34](https://github.com/aussierk/arrlink/commit/1621c34d9f5d8e2de54be29dd6ede4437718cfdc))
* **rules:** rework matching into AND/OR condition chains ([5360ad6](https://github.com/aussierk/arrlink/commit/5360ad63a958c570a2f420020ad95d4dedbf107b))
* **rules:** validate placeholders and jail dir_template at save time ([3f6128b](https://github.com/aussierk/arrlink/commit/3f6128b7981407c9c1966cc854cb7fd57071cd94))
* **settings:** DB-overridable app URL/title/locale/logging/backup settings ([bfbfd4a](https://github.com/aussierk/arrlink/commit/bfbfd4a6459ecb3dcef22cf60002aa5e8d92a75c))
* **settings:** presets, runtime fs fallback, and the Settings page ([af131e9](https://github.com/aussierk/arrlink/commit/af131e95f3f25b10e94c1f4d0b8caa6910b9f003))
* **singleton:** add cross-process single-instance guard ([6796aca](https://github.com/aussierk/arrlink/commit/6796aca701965d5307ce2890a006c3e54b83f805))
* **sonarr:** adapter with episodefile join and tag-id translation ([4765136](https://github.com/aussierk/arrlink/commit/4765136832a2707a8c7ca9603a42558ef8c83bdb))
* **tags:** shared tag repository with push-to-apps ([2e1d17d](https://github.com/aussierk/arrlink/commit/2e1d17db390ce020e62e7fd241fe033eea78dc1f))
* **tags:** stage category edits, add Save button + unsaved-changes guard ([9c94ddb](https://github.com/aussierk/arrlink/commit/9c94ddb0f6f348150ac0167e4a480c1766daaee6))
* **vocabulary:** vocabulary table with TMDB/TRaSH population ([dcd70d5](https://github.com/aussierk/arrlink/commit/dcd70d507c6166b7dc92778a514cb7eb8d6887c3))
* **web:** AND/OR condition builder in the rule editor ([05f3943](https://github.com/aussierk/arrlink/commit/05f394324d0f1706edae3f207c87ef615fac2700))
* **web:** auth gate, login redirect, and allow-list settings ([f4aff02](https://github.com/aussierk/arrlink/commit/f4aff02e5f905af22cb6dc7cfc084ee23e062206))
* **web:** i18n scaffold (react-i18next) with English strings ([2a20cfd](https://github.com/aussierk/arrlink/commit/2a20cfd7f1da598e68a5de4bef1033504759a59a))
* **web:** Links page plus the link browse/repair API ([d99837b](https://github.com/aussierk/arrlink/commit/d99837be51f087334a8242abcf55e22117b84c23))
* **web:** React SPA shell (Apps, Rules, Tags, Dashboard, Logs) ([2043c95](https://github.com/aussierk/arrlink/commit/2043c950599144f0a706cb6529f0c8c962f4c265))
* **web:** Settings sections and Apps folded into Services ([8da9136](https://github.com/aussierk/arrlink/commit/8da91363173e97d5a54e64fa5076eee9f7bceb3a))
* **web:** shared Field/Alert/SubSection, Backup and Logging pages ([eb657c4](https://github.com/aussierk/arrlink/commit/eb657c4c5afa5b8519476758c10b0a2d6efeb6e8))
* **web:** shared UI primitives (Field, Toggle, TagSelect, Collapsible) ([b724b48](https://github.com/aussierk/arrlink/commit/b724b48840176a76b8ffc6a75e3a377e3799740a))
* **web:** vocabulary settings section and tag classification ([6b224a7](https://github.com/aussierk/arrlink/commit/6b224a7c6f0783f3e64804e61bee70c53f1aa890))


### Bug Fixes

* **auth:** close OIDC state race, stop trusting spoofed forwarded-proto ([df47025](https://github.com/aussierk/arrlink/commit/df470251c723fbeb2e49dd364493d684246fdb07))
* **auth:** close open-redirect, host-trust, and settings-bypass gaps ([ba6a939](https://github.com/aussierk/arrlink/commit/ba6a939f7649abcf4c7265b1f032fe320311b2d3))
* **auth:** make the login lockout counter atomic; harden backups ([572b2de](https://github.com/aussierk/arrlink/commit/572b2de51599fb416f4dd8afc17144e3734d620d))
* **fsutil:** close TOCTOU symlink race in hardlink/copy creation ([e35c03f](https://github.com/aussierk/arrlink/commit/e35c03f6379874869edbe33c77f1e2b4694cbbc1))
* **infra:** stop trusting X-Forwarded-* by default, pin backend deps ([3a06621](https://github.com/aussierk/arrlink/commit/3a066214ba81d22264e110cd9dc5a9771cf9dfd4))
* **linker:** purge zombie 'missing' link rows when a dst is relinked ([5244e7b](https://github.com/aussierk/arrlink/commit/5244e7b8f026b43560bd594a1a9c28a44dfc637a))
* **matching:** stop comma collisions in vocabulary-expanded conditions ([6d10a76](https://github.com/aussierk/arrlink/commit/6d10a7625b8581cecb3c9e7950a08f8aadfd3c2e))
* **poller:** stop orphaning hardlinks and leaking poll tasks ([fa7a1e9](https://github.com/aussierk/arrlink/commit/fa7a1e9e19badc60f15041bf10a8c5ee2c655579))
* **tags:** stop sync_app_tags wiping manual category classifications ([022fcf2](https://github.com/aussierk/arrlink/commit/022fcf26ca55bbb9c3333375f4e8b2774279f42a))
* **web:** bump frontend deps + patch react-router-dom open-redirect CVE ([0085d20](https://github.com/aussierk/arrlink/commit/0085d20db041ca933c3fad24e7a5e595a7418c8e))


### Performance Improvements

* **arr:** pool one httpx session across fetch_items ([31e4825](https://github.com/aussierk/arrlink/commit/31e4825e480aefc0a6c6ce3848711fcd850c46fe))
* **fs:** batch filesystem stat calls in the poller and linker ([a0c3a01](https://github.com/aussierk/arrlink/commit/a0c3a017757d55033d44d3d6333a5dbd46769c98))
* **poller:** bulk snapshot diff, chunked commits, Sonarr delta fetch ([72984fa](https://github.com/aussierk/arrlink/commit/72984fa9a287dacf8895c3ead4f0347810a4bf8a))
* **state:** WAL tuning and links/app_files lookup indexes ([c7bc9db](https://github.com/aussierk/arrlink/commit/c7bc9db901f09f9ef2745496034846e40eb60df5))

## [Unreleased]

## [0.1.0] - 2026-08-31

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
  inode-verified writes — handles renames and quality-upgrade replacements
  automatically, never touches source files, and cleans up after itself
  (unlink-on-mismatch) when a rule stops matching.
- **Auth**: password and OIDC login, independently enabled, with
  group/email allow-lists, silent session refresh, and lockout after
  repeated failed password attempts.
- **Settings**, fully structured (no raw JSON) across General, Services,
  Authentication, Vocabulary, and Backup — including application
  identity, localization, live-editable logging, and automatic database
  backup with configurable interval/retention.
- **Dashboard**: connected-app health, a links panel with search/repair,
  and a live event log.
- Multi-stage Docker image, `PUID`/`PGID` support, CI, and a release
  workflow publishing to `ghcr.io/aussierk/arrlink`.

See the [README](README.md) for the full feature list and setup guide.

[Unreleased]: https://github.com/aussierk/arrlink/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/aussierk/arrlink/releases/tag/v0.1.0
