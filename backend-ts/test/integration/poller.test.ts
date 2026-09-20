import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, openDb, type DbClient } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'
import {
  appFiles,
  appItems,
  apps,
  events,
  links as linksTable,
  rules as rulesTable,
} from '../../src/db/schema.js'
import { SettingsStore } from '../../src/db/settings-store.js'
import { Poller } from '../../src/core/poller.js'
import { inodeOf } from '../../src/core/fsutil.js'
import type { Settings } from '../../src/config/env.js'

let dir: string
let mediaDir: string
let linkedDir: string
let db: DbClient
let settingsStore: SettingsStore
let appId: number
let settings: Settings

interface RadarrMovie {
  id: number
  title: string
  year: number
  tags: number[]
  moviePath: string | null
  genres?: string[]
  certification?: string
  qualityProfileId?: number
  originalLanguage?: { name: string }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Mocks the three Radarr endpoints the adapter's fetchSnapshot touches. */
function mockRadarr(movies: RadarrMovie[]): void {
  const fetchMock = vi.fn((url: string | URL) => {
    const u = String(url)
    if (u.includes('/api/v3/tag')) {
      return Promise.resolve(
        jsonResponse([{ id: 1, label: 'kids', count: movies.length }]),
      )
    }
    if (u.includes('/api/v3/qualityprofile')) {
      return Promise.resolve(jsonResponse([{ id: 5, name: 'HD-1080p' }]))
    }
    if (u.includes('/api/v3/language')) {
      return Promise.resolve(jsonResponse([{ id: 1, name: 'English' }]))
    }
    if (u.includes('/api/v3/movie')) {
      return Promise.resolve(
        jsonResponse(
          movies.map((m) => ({
            id: m.id,
            title: m.title,
            year: m.year,
            tags: m.tags,
            movieFile: m.moviePath ? { path: m.moviePath, size: 12 } : null,
            genres: m.genres ?? [],
            certification: m.certification ?? null,
            collection: null,
            qualityProfileId: m.qualityProfileId ?? null,
            originalLanguage: m.originalLanguage ?? null,
          })),
        ),
      )
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  })
  vi.stubGlobal('fetch', fetchMock)
}

function movieFile(name: string): string {
  const p = join(mediaDir, name)
  writeFileSync(p, 'hello')
  return p
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-poller-'))
  mediaDir = join(dir, 'media')
  linkedDir = join(dir, 'linked')
  mkdirSync(mediaDir, { recursive: true })
  mkdirSync(linkedDir, { recursive: true })

  db = openDb(join(dir, 'arrlink.db'))
  runMigrations(db)
  settingsStore = new SettingsStore(db)
  settingsStore.setSetting('allowed_roots', [linkedDir])

  appId = db
    .insert(apps)
    .values({ name: 'Radarr', type: 'radarr', url: 'http://radarr.local', apiKey: 'k' })
    .run().lastInsertRowid as number

  db.insert(rulesTable)
    .values({
      name: 'kids',
      dirTemplate: join(linkedDir, 'kids'),
      conditionsJson: JSON.stringify([
        { category: 'user', matchType: 'exact', matchValue: 'kids', join: null },
      ]),
    })
    .run()

  settings = {
    configDir: dir,
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
    forwardedAllowIps: '127.0.0.1',
    enableDevCors: false,
    backupEnabled: true,
    backupRetentionDays: 7,
    port: 8270,
    logSizeLimitMb: 10,
    dbPath: join(dir, 'arrlink.db'),
    backupDir: join(dir, 'backups'),
    logDir: join(dir, 'logs'),
    logPath: join(dir, 'logs', 'arrlink.log'),
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
  closeDb(db)
  rmSync(dir, { recursive: true, force: true })
})

describe('Poller.rescan', () => {
  it('stores the snapshot and hardlinks a matching file on first poll', async () => {
    const src = movieFile('movie1.mkv')
    mockRadarr([{ id: 1, title: 'Movie1', year: 2020, tags: [1], moviePath: src }])

    const poller = new Poller(db, settings)
    const result = await poller.rescan(appId)
    expect(result.ok).toBe(true)

    const itemRow = db.select().from(appItems).where(eq(appItems.appId, appId)).get()
    expect(itemRow?.title).toBe('Movie1')
    const fileRow = db
      .select()
      .from(appFiles)
      .where(eq(appFiles.itemId, itemRow!.id))
      .get()
    expect(fileRow).toBeDefined()

    const dst = join(linkedDir, 'kids', 'movie1.mkv')
    expect(existsSync(dst)).toBe(true)
    expect(readFileSync(dst, 'utf-8')).toBe('hello')
    expect(inodeOf(dst)).toBe(inodeOf(src))

    const linkRow = db.select().from(linksTable).where(eq(linksTable.dstPath, dst)).get()
    expect(linkRow?.status).toBe('active')

    const appRow = db.select().from(apps).where(eq(apps.id, appId)).get()
    expect(appRow?.itemCount).toBe(1)
    expect(appRow?.lastError).toBeNull()
  })

  it('is idempotent across repeated identical polls', async () => {
    const src = movieFile('movie1.mkv')
    mockRadarr([{ id: 1, title: 'Movie1', year: 2020, tags: [1], moviePath: src }])

    const poller = new Poller(db, settings)
    await poller.rescan(appId)
    await poller.rescan(appId)

    expect(db.select().from(appItems).all()).toHaveLength(1)
    expect(db.select().from(appFiles).all()).toHaveLength(1)
    expect(db.select().from(linksTable).all()).toHaveLength(1)
  })

  it('re-links under a new name when the source file is renamed', async () => {
    const src = movieFile('movie1.mkv')
    mockRadarr([{ id: 1, title: 'Movie1', year: 2020, tags: [1], moviePath: src }])
    const poller = new Poller(db, settings)
    await poller.rescan(appId)
    expect(existsSync(join(linkedDir, 'kids', 'movie1.mkv'))).toBe(true)

    const renamed = join(mediaDir, 'movie1-renamed.mkv')
    renameSync(src, renamed) // real OS rename -- keeps the inode, unlike delete+recreate
    mockRadarr([{ id: 1, title: 'Movie1', year: 2020, tags: [1], moviePath: renamed }])
    await poller.rescan(appId)

    expect(existsSync(join(linkedDir, 'kids', 'movie1.mkv'))).toBe(false)
    expect(existsSync(join(linkedDir, 'kids', 'movie1-renamed.mkv'))).toBe(true)
    expect(db.select().from(linksTable).all()).toHaveLength(1)
  })

  it('reports ok:false and logs a warning when the adapter is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    )
    const poller = new Poller(db, settings)
    const result = await poller.rescan(appId)
    expect(result.ok).toBe(false)

    const appRow = db.select().from(apps).where(eq(apps.id, appId)).get()
    expect(appRow?.lastError).toContain('unreachable')

    const logged = db.select().from(events).all()
    expect(
      logged.some((e) => e.level === 'warn' && e.message.includes('poll failed')),
    ).toBe(true)
  })

  it('forgets an item and unlinks it after DELETE_AFTER consecutive misses', async () => {
    const src = movieFile('movie1.mkv')
    mockRadarr([{ id: 1, title: 'Movie1', year: 2020, tags: [1], moviePath: src }])
    const poller = new Poller(db, settings)
    await poller.rescan(appId)
    const dst = join(linkedDir, 'kids', 'movie1.mkv')
    expect(existsSync(dst)).toBe(true)

    mockRadarr([]) // app no longer reports the movie at all

    await poller.rescan(appId) // strike 1
    expect(db.select().from(appItems).all()).toHaveLength(1)
    expect(existsSync(dst)).toBe(true)

    await poller.rescan(appId) // strike 2
    expect(db.select().from(appItems).all()).toHaveLength(1)
    expect(existsSync(dst)).toBe(true)

    await poller.rescan(appId) // strike 3 -- forgotten
    expect(db.select().from(appItems).all()).toHaveLength(0)
    expect(db.select().from(appFiles).all()).toHaveLength(0)
    expect(existsSync(dst)).toBe(false)

    const linkRow = db.select().from(linksTable).where(eq(linksTable.dstPath, dst)).get()
    expect(linkRow?.status).toBe('missing')
    expect(linkRow?.itemId).toBeNull()
    expect(linkRow?.fileId).toBeNull()
  })

  it('drops a link (but keeps the file row) when the rule no longer matches and unlink is on', async () => {
    const src = movieFile('movie1.mkv')
    mockRadarr([{ id: 1, title: 'Movie1', year: 2020, tags: [1], moviePath: src }])
    const poller = new Poller(db, settings)
    await poller.rescan(appId)
    const dst = join(linkedDir, 'kids', 'movie1.mkv')
    expect(existsSync(dst)).toBe(true)

    // tag no longer reported on this item -> rule stops matching, but the
    // item/file are still live -> no grace strikes involved, retired same poll.
    mockRadarr([{ id: 1, title: 'Movie1', year: 2020, tags: [], moviePath: src }])
    await poller.rescan(appId)

    expect(existsSync(dst)).toBe(false)
    expect(db.select().from(appItems).all()).toHaveLength(1)
    expect(db.select().from(appFiles).all()).toHaveLength(1)
    const linkRow = db.select().from(linksTable).where(eq(linksTable.dstPath, dst)).get()
    expect(linkRow?.status).toBe('missing')
  })
})

describe('Poller.start/stop', () => {
  it('starts and stops without throwing, and stop is idempotent', () => {
    // No mocked fetch here -- disable the app first so the supervisor loop's
    // first tick finds nothing to poll. Otherwise a real pollOnce() kicks off
    // in the background and can still be in flight when afterEach closes db.
    db.update(apps).set({ enabled: 0 }).where(eq(apps.id, appId)).run()
    const poller = new Poller(db, settings)
    poller.start()
    expect(() => {
      poller.stop()
    }).not.toThrow()
    expect(() => {
      poller.stop()
    }).not.toThrow()
  })
})
