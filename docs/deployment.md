# Deployment

## Run with Docker

```sh
cp .env.example .env   # optional
docker compose build
docker compose up -d
# UI: http://<host>:8270
```

The image starts as root to `chown` the mounted volumes, then drops to
`PUID`/`PGID` (default `1000:1000`) via gosu. A healthcheck hits
`/api/health`.

## Paths (important)

- **Media must be visible at the same absolute paths the *arr apps use** --
  mount it read-only (e.g. `/mnt/tank/media:/mnt/tank/media:ro`). ArrLink
  `stat`s the source files and hardlinks them, so the paths must line up.
- **The link root defaults to `/media`** (the allowed root). Mount a
  writable pool at `/media` on the **same filesystem** as the sources so
  hardlinks work -- otherwise the cross-filesystem fallback
  (`skip` / `copy` / `symlink`) kicks in. Presets link under `/media/movies`
  and `/media/tv` by default.
- To use a different root, set the `allowed_roots` Setting
  (Settings → General → Linking) and use matching base folders in your
  rules.

See [`compose.yaml`](../compose.yaml) for a worked example with the volume
lines.

## Environment variables

Seed values only -- most are also editable at runtime in Settings, which
takes precedence. Full annotated list in [`.env.example`](../.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONFIG_DIR` | `/config` | Database, logs, and backups live here |
| `PORT` | `8270` | HTTP bind port |
| `PUID` / `PGID` | `1000` | User/group the process drops to |
| `TZ` | -- | Container timezone |
| `LOG_LEVEL` | `info` | Log level (also live in Settings → General) |
| `LOG_SIZE_LIMIT_MB` | `10` | Rotating log-file size cap |
| `FS_FALLBACK` | `skip` | Cross-filesystem link fallback: `skip` / `copy` / `symlink` |
| `AUTH_PASSWORD_ENABLED` | `false` | Enable password login |
| `UI_USERNAME` / `UI_PASSWORD` | `admin` / -- | Password-login credentials |
| `AUTH_OIDC_ENABLED` | `false` | Enable OIDC login |
| `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | -- | OIDC client config |
| `OIDC_AUTO_LOGIN` | `true` | Redirect `/login` straight to the provider |
| `SESSION_TTL_H` | `12` | Local session lifetime (hours) |
| `APP_URL` | -- | External base URL (scheme + host + optional port/sub-path) |
| `TRUSTED_HOSTS` | -- | Allowed `Host` header values (comma-separated) |
| `FORWARDED_ALLOW_IPS` | localhost | Reverse-proxy IP/CIDR whose forwarded headers are trusted |
| `BACKUP_ENABLED` | `true` | Nightly database backup |
| `BACKUP_RETENTION_DAYS` | `7` | Backup retention |

See [authentication.md](authentication.md) for the auth variables and
[security.md](security.md) for `APP_URL` / `TRUSTED_HOSTS` /
`FORWARDED_ALLOW_IPS`.

## Radarr / Sonarr compatibility

Targets the `/v3/` API surface of current Radarr/Sonarr releases (`/v3/tag`,
`/v3/movie`, `/v3/series`, `/v3/episodefile`, etc.). No specific minimum
version has been verified or pinned -- if something breaks against your
version, please [open an issue](https://github.com/aussierk/arrlink/issues).