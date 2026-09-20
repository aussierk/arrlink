import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type { DbClient } from '../db/client.js'
import { logEvent } from '../db/events.js'
import type { SettingsStore } from '../db/settings-store.js'
import type { Settings } from '../config/env.js'

/** Nightly DB backup with retention. Ported from core/backup.py. */

const FILENAME_RE = /^arrlink-\d{8}-\d{6}-[0-9a-f]{6}\.db$/

// How often the background loop checks whether a backup is due, and how
// stale the newest backup has to be before one runs. A staleness check is
// restart-safe: no in-memory "next run at" timer to lose.
export const CHECK_INTERVAL_S = 3600
export const STALE_S = 24 * 3600
export const DEFAULT_INTERVAL_HOURS = Math.floor(STALE_S / 3600)

function stamp(): string {
  const d = new Date()
  const p = (n: number, len = 2): string => String(n).padStart(len, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

function listBackupFiles(backupDir: string): string[] {
  if (!existsSync(backupDir)) return []
  return readdirSync(backupDir).filter((n) => FILENAME_RE.test(n))
}

/** Create one backup of `dbPath` under `backupDir` using SQLite's online backup API
 * (WAL-safe, unlike a raw file copy). Returns the new file's path. Throws on failure --
 * callers wanting a non-throwing, logged outcome should use runBackupCycle instead. */
export async function backupNow(dbPath: string, backupDir: string): Promise<string> {
  mkdirSync(backupDir, { recursive: true })
  // A short random suffix, not just the second-resolution timestamp: two
  // backups landing in the same second would otherwise collide.
  const dest = join(backupDir, `arrlink-${stamp()}-${randomBytes(3).toString('hex')}.db`)
  const src = new Database(dbPath, { readonly: true })
  try {
    await src.backup(dest)
  } finally {
    src.close()
  }
  return dest
}

/** Delete backups (matching the arrlink-* filename pattern only) older than
 * `retentionDays`. Returns the paths removed. */
export function pruneOldBackups(backupDir: string, retentionDays: number): string[] {
  if (!existsSync(backupDir)) return []
  // Clamp: a non-positive retentionDays would move the cutoff into the
  // future and prune the backup just created in this same cycle.
  const cutoff = Date.now() / 1000 - Math.max(1, retentionDays) * 86400
  const removed: string[] = []
  for (const name of listBackupFiles(backupDir)) {
    const p = join(backupDir, name)
    try {
      if (statSync(p).mtimeMs / 1000 < cutoff) {
        unlinkSync(p)
        removed.push(p)
      }
    } catch (e) {
      console.warn(`failed to prune backup ${p}: ${String(e)}`)
    }
  }
  return removed
}

/** Age in seconds of the newest backup, or null if there are none yet. */
export function newestBackupAgeS(backupDir: string): number | null {
  const files = listBackupFiles(backupDir)
  if (files.length === 0) return null
  const newest = Math.max(
    ...files.map((n) => statSync(join(backupDir, n)).mtimeMs / 1000),
  )
  return Date.now() / 1000 - newest
}

export interface BackupInfo {
  name: string
  size: number
  createdAt: number
}

export function listBackups(backupDir: string): BackupInfo[] {
  return listBackupFiles(backupDir)
    .sort()
    .reverse()
    .map((name) => {
      const st = statSync(join(backupDir, name))
      return { name, size: st.size, createdAt: st.mtimeMs / 1000 }
    })
}

/** (enabled, retentionDays, intervalHours) -- a runtime Setting overrides the env
 * default, same DB-wins-when-set pattern as effectiveAuth. */
export function effectiveBackupSettings(
  settingsStore: SettingsStore,
  settings: Settings,
): { enabled: boolean; retentionDays: number; intervalHours: number } {
  const dbEnabled = settingsStore.getSetting<boolean>('backup_enabled')
  const enabled = dbEnabled !== undefined ? Boolean(dbEnabled) : settings.backupEnabled
  const dbRetention = settingsStore.getSetting<number>('backup_retention_days')
  const retentionDays =
    dbRetention !== undefined ? Number(dbRetention) : settings.backupRetentionDays
  const dbInterval = settingsStore.getSetting<number>('backup_interval_hours')
  const intervalHours =
    dbInterval !== undefined ? Number(dbInterval) : DEFAULT_INTERVAL_HOURS
  return { enabled, retentionDays, intervalHours }
}

export type BackupCycleResult =
  { ok: true; path: string; size: number; pruned: number } | { ok: false; error: string }

/** Back up, prune, and log the outcome via logEvent. Never throws. */
export async function runBackupCycle(
  db: DbClient,
  dbPath: string,
  backupDir: string,
  retentionDays: number,
): Promise<BackupCycleResult> {
  try {
    const dest = await backupNow(dbPath, backupDir)
    const size = statSync(dest).size
    const removed = pruneOldBackups(backupDir, retentionDays)
    logEvent(
      db,
      'info',
      `DB backup created: ${dest.split(/[\\/]/).pop()} (${size} bytes)` +
        (removed.length ? `, pruned ${removed.length} old backup(s)` : ''),
    )
    return { ok: true, path: dest, size, pruned: removed.length }
  } catch (e) {
    logEvent(db, 'error', `DB backup failed: ${String(e)}`)
    return { ok: false, error: String(e) }
  }
}
