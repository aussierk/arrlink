import { OidcClient } from '../auth/oidc.js'
import { runSweep, SWEEP_INTERVAL_S } from '../auth/sessions.js'
import type { Settings } from '../config/env.js'
import { effectiveAuth } from '../config/runtime.js'
import type { DbClient } from '../db/client.js'
import { logEvent } from '../db/events.js'
import type { SettingsStore } from '../db/settings-store.js'
import {
  CHECK_INTERVAL_S,
  effectiveBackupSettings,
  newestBackupAgeS,
  runBackupCycle,
} from './backup.js'
import { sleep } from './poller.js'

/** Two standalone background loops ported from main.py's `_auth_sweep` and
 * `_backup_loop` -- independent of the Poller, so they live here rather than
 * in poller.ts. */

/** Silently refreshes OIDC sessions nearing expiry. Always running (auth mode
 * can change at runtime); stays dormant until OIDC is active. */
export async function authSweepLoop(
  db: DbClient,
  settingsStore: SettingsStore,
  env: Settings,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    await sleep(SWEEP_INTERVAL_S * 1000, signal)
    if (signal.aborted) return
    const auth = effectiveAuth(settingsStore, env)
    if (!auth.oidcEnabled) continue
    try {
      const factory = (): OidcClient =>
        new OidcClient(auth.oidcIssuer, auth.oidcClientId, auth.oidcClientSecret || '')
      const stats = await runSweep(db, factory, auth.sessionTtlH)
      if (stats.failed) {
        logEvent(
          db,
          'warn',
          `auth sweep: ${stats.failed} session(s) dropped, ${stats.refreshed} refreshed`,
        )
      }
    } catch (e) {
      console.warn(`auth sweep error: ${String(e)}`)
    }
  }
}

/** Periodic DB backup with retention, staleness-checked every CHECK_INTERVAL_S
 * so it's restart-safe (no in-memory "next run at" timer to lose). */
export async function backupLoop(
  db: DbClient,
  settingsStore: SettingsStore,
  env: Settings,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const { enabled, retentionDays, intervalHours } = effectiveBackupSettings(
        settingsStore,
        env,
      )
      if (enabled) {
        const age = newestBackupAgeS(env.backupDir)
        if (age === null || age > intervalHours * 3600) {
          await runBackupCycle(db, env.dbPath, env.backupDir, retentionDays)
        }
      }
    } catch (e) {
      console.warn(`backup loop error: ${String(e)}`)
    }
    await sleep(CHECK_INTERVAL_S * 1000, signal)
  }
}
