import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, openDb, type DbClient } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'
import { events } from '../../src/db/schema.js'
import { SettingsStore } from '../../src/db/settings-store.js'
import {
  DEFAULT_INTERVAL_HOURS,
  backupNow,
  effectiveBackupSettings,
  listBackups,
  newestBackupAgeS,
  pruneOldBackups,
  runBackupCycle,
} from '../../src/core/backup.js'
import type { Settings } from '../../src/config/env.js'

let dir: string
let dbPath: string
let backupDir: string
let db: DbClient

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-backup-'))
  dbPath = join(dir, 'arrlink.db')
  backupDir = join(dir, 'backups')
  db = openDb(dbPath)
  runMigrations(db)
})

afterEach(() => {
  closeDb(db)
  rmSync(dir, { recursive: true, force: true })
})

describe('backupNow', () => {
  it('creates a real, independently-readable backup file', async () => {
    const dest = await backupNow(dbPath, backupDir)
    expect(existsSync(dest)).toBe(true)

    const copy = openDb(dest)
    try {
      const rows = copy.select().from(events).all()
      expect(rows).toEqual([])
    } finally {
      closeDb(copy)
    }
  })

  it('gives two rapid backups distinct filenames', async () => {
    const a = await backupNow(dbPath, backupDir)
    const b = await backupNow(dbPath, backupDir)
    expect(a).not.toBe(b)
    expect(listBackups(backupDir)).toHaveLength(2)
  })
})

describe('pruneOldBackups', () => {
  it('removes only backups older than the retention window', async () => {
    const oldFile = await backupNow(dbPath, backupDir)
    const oldTime = (Date.now() - 10 * 86400 * 1000) / 1000
    utimesSync(oldFile, oldTime, oldTime)
    const newFile = await backupNow(dbPath, backupDir)

    const removed = pruneOldBackups(backupDir, 7)
    expect(removed).toEqual([oldFile])
    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(newFile)).toBe(true)
  })

  it('clamps a non-positive retention to avoid pruning a just-created backup', async () => {
    const fresh = await backupNow(dbPath, backupDir)
    pruneOldBackups(backupDir, 0)
    expect(existsSync(fresh)).toBe(true)
  })

  it('returns an empty list when the backup dir does not exist yet', () => {
    expect(pruneOldBackups(join(dir, 'nope'), 7)).toEqual([])
  })

  it('never touches a file that does not match the backup naming pattern', () => {
    mkdirSync(backupDir, { recursive: true })
    const stray = join(backupDir, 'not-a-backup.db')
    writeFileSync(stray, 'x')
    const oldTime = (Date.now() - 10 * 86400 * 1000) / 1000
    utimesSync(stray, oldTime, oldTime)

    pruneOldBackups(backupDir, 7)
    expect(existsSync(stray)).toBe(true)
  })
})

describe('newestBackupAgeS / listBackups', () => {
  it('returns null when there are no backups yet', () => {
    expect(newestBackupAgeS(backupDir)).toBeNull()
    expect(listBackups(backupDir)).toEqual([])
  })

  it('reports a small age for a just-created backup', async () => {
    await backupNow(dbPath, backupDir)
    const age = newestBackupAgeS(backupDir)
    expect(age).not.toBeNull()
    expect(age!).toBeLessThan(5)
  })

  it('lists backups newest first with name/size/createdAt', async () => {
    // The filename's timestamp has second resolution and listBackups sorts
    // by filename, so the two backups must land in different seconds for a
    // deterministic order (otherwise the tiebreak is an unordered random suffix).
    await backupNow(dbPath, backupDir)
    await new Promise((r) => setTimeout(r, 1100))
    const second = await backupNow(dbPath, backupDir)
    const listed = listBackups(backupDir)
    expect(listed).toHaveLength(2)
    expect(listed[0].name).toBe(second.split(/[\\/]/).pop())
    expect(listed[0].size).toBe(statSync(second).size)
  })
})

describe('effectiveBackupSettings', () => {
  function baseSettings(): Settings {
    return {
      configDir: 'config',
      logLevel: 'info',
      fsFallback: 'skip',
      authPasswordEnabled: false,
      authOidcEnabled: false,
      oidcAutoLogin: true,
      uiUsername: 'admin',
      uiPassword: undefined,
      uiPasswordHash: '',
      oidcIssuer: undefined,
      oidcClientId: undefined,
      oidcClientSecret: undefined,
      sessionTtlH: 12,
      appUrl: undefined,
      trustedHosts: undefined,
      enableDevCors: false,
      backupEnabled: true,
      backupRetentionDays: 7,
      port: 8270,
      logSizeLimitMb: 10,
      dbPath,
      backupDir,
      logDir: join(dir, 'logs'),
      logPath: join(dir, 'logs', 'arrlink.log'),
    }
  }

  it('falls back to env defaults when nothing is set in the DB', () => {
    const store = new SettingsStore(db)
    const eff = effectiveBackupSettings(store, baseSettings())
    expect(eff).toEqual({
      enabled: true,
      retentionDays: 7,
      intervalHours: DEFAULT_INTERVAL_HOURS,
    })
  })

  it('an explicit DB false overrides an env true', () => {
    const store = new SettingsStore(db)
    store.setSetting('backup_enabled', false)
    const eff = effectiveBackupSettings(store, baseSettings())
    expect(eff.enabled).toBe(false)
  })
})

describe('runBackupCycle', () => {
  it('backs up, prunes, and logs an info event on success', async () => {
    const result = await runBackupCycle(db, dbPath, backupDir, 7)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(existsSync(result.path)).toBe(true)
      expect(result.pruned).toBe(0)
    }
    const logged = db.select().from(events).all()
    expect(
      logged.some((e) => e.level === 'info' && e.message.includes('DB backup created')),
    ).toBe(true)
  })

  it('logs an error event and returns ok:false on failure instead of throwing', async () => {
    const result = await runBackupCycle(
      db,
      join(dir, 'nonexistent-db-file.db'),
      backupDir,
      7,
    )
    expect(result.ok).toBe(false)
    const logged = db.select().from(events).all()
    expect(
      logged.some((e) => e.level === 'error' && e.message.includes('DB backup failed')),
    ).toBe(true)
  })
})
