# Backups

`/config/backups/arrlink-YYYYMMDD-HHMMSS.db` — an automatic backup of the
whole database (rules, apps, settings — everything except the physical
media/hardlinks themselves, which live independently), on a configurable
interval (default 24 h) with retention (default 7 days).

It uses SQLite's own online backup API, so it's safe against a live
database — no downtime, no pausing the poller.

Enabled / interval / retention are editable live from Settings → Backup
(seeded from `BACKUP_ENABLED` / `BACKUP_RETENTION_DAYS`). That page also
lists existing backups and can trigger one manually — the same
`GET /api/backup` / `POST /api/backup/run` endpoints the UI uses.

This does **not** back up your actual media or hardlinks — just ArrLink's
own configuration database.