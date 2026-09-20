import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, openDb, type DbClient } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'
import { SettingsStore } from '../../src/db/settings-store.js'

let dir: string
let db: DbClient
let store: SettingsStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-settings-'))
  db = openDb(join(dir, 'arrlink.db'))
  runMigrations(db)
  store = new SettingsStore(db)
})

afterEach(() => {
  closeDb(db)
  rmSync(dir, { recursive: true, force: true })
})

describe('SettingsStore', () => {
  it('returns the default when a key is unset', () => {
    expect(store.getSetting('app_url')).toBeUndefined()
    expect(store.getSetting('app_url', 'fallback')).toBe('fallback')
  })

  it('round-trips a value through set/get', () => {
    store.setSetting('app_url', 'https://example.com')
    expect(store.getSetting('app_url')).toBe('https://example.com')
  })

  it('upserts on repeated writes to the same key', () => {
    store.setSetting('log_level', 'info')
    store.setSetting('log_level', 'debug')
    expect(store.getSetting('log_level')).toBe('debug')
  })

  it('deletes a key', () => {
    store.setSetting('app_title', 'ArrLink')
    store.deleteSetting('app_title')
    expect(store.getSetting('app_title')).toBeUndefined()
  })

  it('masks sensitive keys from allSettings but keeps non-sensitive ones', () => {
    store.setSetting('auth_password', 'secret-hash')
    store.setSetting('oidc_client_secret', 'secret-value')
    store.setSetting('tmdb_api_key', 'secret-key')
    store.setSetting('app_url', 'https://example.com')

    const all = store.allSettings()
    expect(all).toEqual({ app_url: 'https://example.com' })
  })

  it('preserves falsy values (false, 0, "") as explicitly set', () => {
    store.setSetting('auth_password_enabled', false)
    store.setSetting('log_size_limit_mb', 0)

    expect(store.getSetting('auth_password_enabled')).toBe(false)
    expect(store.getSetting('log_size_limit_mb')).toBe(0)
  })
})
