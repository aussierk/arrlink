# ArrLink

Tag-based **hardlink manager** for **Radarr** and **Sonarr**. Point it at
your apps, map tags (or metadata) to destination path/filename templates,
and ArrLink keeps matching media hardlinked into organized folders as
imports and tags change.

[![CI](https://github.com/aussierk/arrlink/actions/workflows/ci.yml/badge.svg)](https://github.com/aussierk/arrlink/actions/workflows/ci.yml)
[![CodeQL](https://github.com/aussierk/arrlink/actions/workflows/codeql.yml/badge.svg)](https://github.com/aussierk/arrlink/actions/workflows/codeql.yml)
[![Container](https://img.shields.io/badge/ghcr.io-aussierk%2Farrlink-blue?logo=docker)](https://github.com/aussierk/arrlink/pkgs/container/arrlink)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> **Status:** early public release. Single-maintainer homelab tool -- it
> works and is in day-to-day use, but expect rough edges. Issues and PRs
> welcome (see [Contributing](#contributing)).

## Features

- Works with **Radarr** and **Sonarr**
- **Automatic scanning** -- polls each app and reacts to new imports, tag
  changes, renames, and quality upgrades
- **Rules engine** -- match on **tags or metadata**, combine conditions with
  **AND/OR**, render dir + filename templates, and see a **live preview
  before anything is written**
- **Presets** for common conventions (user tags, certification, kids,
  4K/HDR) as a one-click starting point
- **Safe hardlinks** -- inode-verified and idempotent across restarts;
  source files are never touched, foreign files are never clobbered
- Ships as a single **Docker** container (`PUID`/`PGID`, healthcheck);
  optional **password** and/or **OIDC** login

## Quick start

```sh
cp .env.example .env        # optional
docker compose up -d
# UI: http://<host>:8270
```

Media must be visible to the container at the **same absolute paths** the
*arr apps use, and the link root must sit on the **same filesystem** as the
sources. See [docs/deployment.md](docs/deployment.md) for volumes and path
mirroring.

## Develop

```sh
# backend
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
CONFIG_DIR=./config .venv/bin/python -m uvicorn arrlink.main:create_app \
  --factory --app-dir backend --port 8270 --reload

# frontend (proxies /api to :8270)
cd web && npm install && npm run dev   # http://localhost:5173
```

## Documentation

- [docs/features.md](docs/features.md) -- full feature detail and project layout
- [docs/deployment.md](docs/deployment.md) -- Docker, volumes, path mirroring, env vars, compatibility
- [docs/authentication.md](docs/authentication.md) -- password / OIDC setup, lockout
- [docs/security.md](docs/security.md) -- exposure, reverse proxies, trusted hosts
- [docs/backups.md](docs/backups.md) -- the automatic database backup

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). PR titles follow
[Conventional Commits](https://www.conventionalcommits.org/), and
AI-assisted work must be disclosed in the PR (details in CONTRIBUTING).

## Support & community

- **Questions, ideas, show-and-tell:** [GitHub Discussions](https://github.com/aussierk/arrlink/discussions)
- **Bugs:** [open an issue](https://github.com/aussierk/arrlink/issues)
- **Security vulnerabilities:** see [SECURITY.md](SECURITY.md) -- please don't
  file them as public issues

## License

[MIT](LICENSE)
