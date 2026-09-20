import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Settings } from '../config/env.js'
import type { DbClient } from '../db/client.js'
import type { SettingsStore } from '../db/settings-store.js'
import { effectiveBackupSettings, listBackups, runBackupCycle } from '../core/backup.js'
import { logEvent } from '../db/events.js'
import { HttpError } from '../http-error.js'
import { getCurrentUser } from './auth.js'

/** DB backup endpoints: list existing backups, trigger one manually. Ported
 * from api/backup.py. */

export interface BackupRouteOptions {
  db: DbClient
  settingsStore: SettingsStore
  env: Settings
}

const BackupSettingsSchema = z.object({
  enabled: z.boolean(),
  retentionDays: z.number().int(),
  intervalHours: z.number().int(),
})

export function registerBackupRoutes(
  app: FastifyInstance,
  opts: BackupRouteOptions,
): void {
  const { db, settingsStore, env } = opts

  app.get('/api/backup', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    return listBackups(env.backupDir)
  })

  app.get('/api/backup/settings', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const { enabled, retentionDays, intervalHours } = effectiveBackupSettings(
      settingsStore,
      env,
    )
    return { enabled, retentionDays, intervalHours }
  })

  app.put('/api/backup/settings', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const parsed = BackupSettingsSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    const body = parsed.data
    settingsStore.setSetting('backup_enabled', body.enabled)
    settingsStore.setSetting('backup_retention_days', body.retentionDays)
    settingsStore.setSetting('backup_interval_hours', body.intervalHours)
    logEvent(
      db,
      'info',
      `backup settings updated (enabled=${body.enabled}, retention_days=${body.retentionDays}, ` +
        `interval_hours=${body.intervalHours})`,
    )
    return body
  })

  app.post('/api/backup/run', async (request) => {
    getCurrentUser(request, db, settingsStore, env)
    // Manual trigger always runs regardless of `enabled` -- that flag only
    // gates the automatic nightly loop; a manual "run now" is an explicit
    // admin action and should always be honored.
    const { retentionDays } = effectiveBackupSettings(settingsStore, env)
    return runBackupCycle(db, env.dbPath, env.backupDir, retentionDays)
  })
}
