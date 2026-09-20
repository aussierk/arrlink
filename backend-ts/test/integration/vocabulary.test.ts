import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, openDb, type DbClient } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'
import {
  apps,
  tags as tagsTable,
  vocabulary as vocabularyTable,
} from '../../src/db/schema.js'
import { SettingsStore } from '../../src/db/settings-store.js'
import {
  expandVocabularyConditions,
  syncTmdbVocabulary,
  syncTrashVocabulary,
  tmdbApiKey,
  validateConditionValues,
} from '../../src/core/vocabulary.js'
import type { PlannerRule } from '../../src/core/planner.js'

let dir: string
let db: DbClient
let settingsStore: SettingsStore
let appId: number

function rule(overrides: Partial<PlannerRule> = {}): PlannerRule {
  return {
    id: 1,
    name: 'r',
    appScope: null,
    appTypeScope: null,
    conditions: [],
    dirTemplate: '/linked/x',
    filenameTemplate: null,
    enabled: true,
    priority: 100,
    ...overrides,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-vocab-'))
  db = openDb(join(dir, 'arrlink.db'))
  runMigrations(db)
  settingsStore = new SettingsStore(db)
  appId = db
    .insert(apps)
    .values({ name: 'Radarr', type: 'radarr', url: 'http://x', apiKey: 'k' })
    .run().lastInsertRowid as number
})

afterEach(() => {
  vi.unstubAllGlobals()
  closeDb(db)
  rmSync(dir, { recursive: true, force: true })
})

describe('expandVocabularyConditions', () => {
  it('replaces a vocabulary condition with a sorted list of known + tag-classified values', () => {
    db.insert(vocabularyTable)
      .values([
        {
          category: 'genre',
          appType: 'radarr',
          appId: null,
          value: 'Horror',
          source: 'tmdb',
          importedAt: 0,
        },
        {
          category: 'genre',
          appType: 'radarr',
          appId: null,
          value: 'Comedy',
          source: 'tmdb',
          importedAt: 0,
        },
      ])
      .run()
    db.insert(tagsTable)
      .values({ appId, label: 'scary', category: 'genre', importedAt: 0 })
      .run()

    const rules = [
      rule({
        conditions: [
          { category: 'genre', matchType: 'vocabulary', matchValue: '', join: null },
        ],
      }),
    ]
    const [expanded] = expandVocabularyConditions(rules, db, appId, 'radarr')
    expect(expanded.conditions[0].matchType).toBe('list')
    expect(JSON.parse(expanded.conditions[0].matchValue)).toEqual([
      'Comedy',
      'Horror',
      'scary',
    ])
  })

  it('expands to an empty list for an unscoped rule (no app_type)', () => {
    const rules = [
      rule({
        conditions: [
          { category: 'genre', matchType: 'vocabulary', matchValue: '', join: null },
        ],
      }),
    ]
    const [expanded] = expandVocabularyConditions(rules, db, null, null)
    expect(JSON.parse(expanded.conditions[0].matchValue)).toEqual([])
  })

  it('leaves non-vocabulary conditions untouched', () => {
    const rules = [
      rule({
        conditions: [
          { category: 'custom', matchType: 'exact', matchValue: 'kids', join: null },
        ],
      }),
    ]
    const [expanded] = expandVocabularyConditions(rules, db, appId, 'radarr')
    expect(expanded.conditions[0]).toEqual(rules[0].conditions[0])
  })
})

describe('validateConditionValues', () => {
  it('flags an exact value not present in the known vocabulary', () => {
    db.insert(vocabularyTable)
      .values({
        category: 'genre',
        appType: 'radarr',
        appId: null,
        value: 'Horror',
        source: 'tmdb',
        importedAt: 0,
      })
      .run()
    const warnings = validateConditionValues(
      { category: 'genre', matchType: 'exact', matchValue: 'Sci-Fi', join: null },
      db,
      'radarr',
      appId,
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Sci-Fi')
  })

  it('does not flag a known value', () => {
    db.insert(vocabularyTable)
      .values({
        category: 'genre',
        appType: 'radarr',
        appId: null,
        value: 'Horror',
        source: 'tmdb',
        importedAt: 0,
      })
      .run()
    const warnings = validateConditionValues(
      { category: 'genre', matchType: 'exact', matchValue: 'Horror', join: null },
      db,
      'radarr',
      appId,
    )
    expect(warnings).toEqual([])
  })

  it('never flags regex conditions (no finite value to check)', () => {
    const warnings = validateConditionValues(
      { category: 'genre', matchType: 'regex', matchValue: '^Sci', join: null },
      db,
      'radarr',
      appId,
    )
    expect(warnings).toEqual([])
  })

  it('no-ops when the vocabulary for that scope is entirely empty', () => {
    const warnings = validateConditionValues(
      { category: 'genre', matchType: 'exact', matchValue: 'Anything', join: null },
      db,
      'radarr',
      appId,
    )
    expect(warnings).toEqual([])
  })

  it('no-ops for a category with no vocabulary concept (e.g. custom/user)', () => {
    const warnings = validateConditionValues(
      { category: 'custom', matchType: 'exact', matchValue: 'kids', join: null },
      db,
      'radarr',
      appId,
    )
    expect(warnings).toEqual([])
  })
})

describe('tmdbApiKey', () => {
  it('prefers the DB setting over the env default', () => {
    settingsStore.setSetting('tmdb_api_key', 'from-db')
    process.env.TMDB_API_KEY = 'from-env'
    expect(tmdbApiKey(settingsStore)).toBe('from-db')
    delete process.env.TMDB_API_KEY
  })

  it('falls back to the env var when unset in the DB', () => {
    process.env.TMDB_API_KEY = 'from-env'
    expect(tmdbApiKey(settingsStore)).toBe('from-env')
    delete process.env.TMDB_API_KEY
  })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('syncTmdbVocabulary', () => {
  it('no-ops without throwing when no TMDB key is configured', async () => {
    const counts = await syncTmdbVocabulary(db, settingsStore)
    expect(counts).toEqual({})
  })

  it('fetches genres + certifications and persists them as shared vocabulary', async () => {
    settingsStore.setSetting('tmdb_api_key', 'test-key')
    const fetchMock = vi.fn((url: string | URL) => {
      const u = String(url)
      if (u.includes('/genre/movie/list')) {
        return Promise.resolve(jsonResponse({ genres: [{ id: 27, name: 'Horror' }] }))
      }
      if (u.includes('/genre/tv/list')) {
        return Promise.resolve(jsonResponse({ genres: [{ id: 35, name: 'Comedy' }] }))
      }
      if (u.includes('/certification/movie/list')) {
        return Promise.resolve(
          jsonResponse({ certifications: { US: [{ certification: 'PG-13' }] } }),
        )
      }
      if (u.includes('/certification/tv/list')) {
        return Promise.resolve(
          jsonResponse({ certifications: { US: [{ certification: 'TV-14' }] } }),
        )
      }
      return Promise.resolve(new Response('not found', { status: 404 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const counts = await syncTmdbVocabulary(db, settingsStore)
    expect(counts).toEqual({
      'genre:radarr': 1,
      'genre:sonarr': 1,
      'certification:radarr': 1,
      'certification:sonarr': 1,
    })

    const rows = db.select().from(vocabularyTable).all()
    expect(
      rows.find((r) => r.category === 'genre' && r.appType === 'radarr')?.value,
    ).toBe('Horror')
    expect(
      rows.find((r) => r.category === 'certification' && r.appType === 'sonarr')?.value,
    ).toBe('TV-14')
  })
})

describe('syncTrashVocabulary', () => {
  it('fetches the TRaSH quality list and persists deduplicated names', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse([
            { name: 'WEBDL-1080p' },
            { name: 'WEBDL-1080p' },
            { name: 'HDTV-720p' },
          ]),
        ),
    )
    const n = await syncTrashVocabulary(db, 'radarr')
    expect(n).toBe(2)
    const rows = db.select().from(vocabularyTable).all()
    expect(new Set(rows.map((r) => r.value))).toEqual(
      new Set(['WEBDL-1080p', 'HDTV-720p']),
    )
  })
})
