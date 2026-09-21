import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Settings } from '../config/env.js'
import type { DbClient } from '../db/client.js'
import type { SettingsStore } from '../db/settings-store.js'
import {
  effectiveBackupSettings,
  listBackups,
  runBackupCycle,
  type BackupInfo,
} from '../core/backup.js'
import { logEvent } from '../db/events.js'
import { HttpError } from '../http-error.js'
import { getCurrentUser } from './auth.js'

/** DB backup endpoints. Ported from api/backup.py. Wire format is snake_case,
 * matching web/ and the Python backend. */

export interface BackupRouteOptions {
  db: DbClient
  settingsStore: SettingsStore
  env: Settings
}

const BackupSettingsSchema = z.object({
  enabled: z.boolean(),
  retention_days: z.number().int(),
  interval_hours: z.number().int(),
})

function backupOut(b: BackupInfo): Record<string, unknown> {
  return { name: b.name, size: b.size, created_at: b.createdAt }
}

export function registerBackupRoutes(
  app: FastifyInstance,
  opts: BackupRouteOptions,
): void {
  const { db, settingsStore, env } = opts

  app.get('/api/backup', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    return listBackups(env.backupDir).map(backupOut)
  })

  app.get('/api/backup/settings', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const { enabled, retentionDays, intervalHours } = effectiveBackupSettings(
      settingsStore,
      env,
    )
    return { enabled, retention_days: retentionDays, interval_hours: intervalHours }
  })

  app.put('/api/backup/settings', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const parsed = BackupSettingsSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    const body = parsed.data
    settingsStore.setSetting('backup_enabled', body.enabled)
    settingsStore.setSetting('backup_retention_days', body.retention_days)
    settingsStore.setSetting('backup_interval_hours', body.interval_hours)
    logEvent(
      db,
      'info',
      `backup settings updated (enabled=${body.enabled}, retention_days=${body.retention_days}, ` +
        `interval_hours=${body.interval_hours})`,
    )
    return body
  })

  app.post('/api/backup/run', async (request) => {
    getCurrentUser(request, db, settingsStore, env)
    // Ignores `enabled` -- that flag only gates the automatic nightly loop.
    const { retentionDays } = effectiveBackupSettings(settingsStore, env)
    return runBackupCycle(db, env.dbPath, env.backupDir, retentionDays)
  })
}
