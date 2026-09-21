import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdapterError } from '../../src/arr/types.js'
import { SonarrAdapter } from '../../src/arr/sonarr.js'

const API_KEY = 'm5-key'
const VERSION = '4.0.12.3001'

interface SeriesFile {
  path: string
  size: number
  languages?: string[]
}

interface Series {
  id: number
  title: string
  year: number
  path: string
  tags: number[]
  files: SeriesFile[]
}

/** Mirrors tests/test_sonarr_adapter.py's Tv fixture, driven via a fetch mock
 * router instead of a real HTTP server -- real files on disk so inode
 * assertions and the delta-fetch skip logic are genuinely exercised. */
class Tv {
  series: Series[] = []
  episodefileCalls: number[] = []
  private tagIds = new Map<string, number>()
  private nextTagId = 1

  constructor(public mediaDir: string) {}

  private tagId(label: string): number {
    if (!this.tagIds.has(label)) this.tagIds.set(label, this.nextTagId++)
    return this.tagIds.get(label)!
  }

  addSeries(path: string, title: string, year: number, tags: string[]): Series {
    const seriesDir = join(this.mediaDir, path)
    mkdirSync(seriesDir, { recursive: true })
    const s: Series = {
      id: this.series.length + 1,
      title,
      year,
      path: seriesDir,
      tags: tags.map((t) => this.tagId(t)),
      files: [],
    }
    this.series.push(s)
    return s
  }

  addEpisode(
    seriesIndex: number,
    relPath: string,
    data = 'episode data',
    languages?: string[],
  ): void {
    const s = this.series[seriesIndex]
    const full = join(s.path, relPath)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, data)
    s.files.push({ path: full, size: statSync(full).size, languages })
  }

  setSeriesTags(index: number, labels: string[]): void {
    this.series[index].tags = labels.map((l) => this.tagId(l))
  }

  private statistics(s: Series): { episodeFileCount: number; sizeOnDisk: number } {
    const present = s.files.filter((f) => statSyncSafe(f.path))
    return {
      episodeFileCount: present.length,
      sizeOnDisk: present.reduce((sum, f) => sum + statSync(f.path).size, 0),
    }
  }

  seriesPayload(): unknown[] {
    return this.series.map((s) => ({
      id: s.id,
      title: s.title,
      year: s.year,
      path: s.path,
      tags: s.tags,
      statistics: this.statistics(s),
    }))
  }

  filesBySeries(seriesId: number): unknown[] {
    const s = this.series.find((x) => x.id === seriesId)
    if (!s) return []
    return s.files.map((f, i) => ({
      id: i + 1,
      path: f.path,
      size: f.size,
      languages: f.languages?.map((name, li) => ({ id: li + 1, name })),
    }))
  }

  tagPayload(): unknown[] {
    return [...this.tagIds.entries()].map(([label, id]) => ({ id, label, count: 0 }))
  }
}

function statSyncSafe(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubSonarr(tv: Tv, apiKey = API_KEY): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const headers = new Headers(init?.headers)
    if (headers.get('x-api-key') !== apiKey) {
      return Promise.resolve(jsonResponse({}, 401))
    }
    if (u.pathname === '/api/v3/system/status') {
      return Promise.resolve(jsonResponse({ version: VERSION, appName: 'Sonarr' }))
    }
    if (u.pathname === '/api/v3/tag') {
      return Promise.resolve(jsonResponse(tv.tagPayload()))
    }
    if (u.pathname === '/api/v3/series') {
      return Promise.resolve(jsonResponse(tv.seriesPayload()))
    }
    if (u.pathname === '/api/v3/episodefile') {
      const seriesId = Number(u.searchParams.get('seriesId'))
      tv.episodefileCalls.push(seriesId)
      return Promise.resolve(jsonResponse(tv.filesBySeries(seriesId)))
    }
    if (u.pathname === '/api/v3/qualityprofile') {
      return Promise.resolve(jsonResponse([]))
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

let mediaDir: string
let tv: Tv

beforeEach(() => {
  mediaDir = mkdtempSync(join(tmpdir(), 'arrlink-sonarr-media-'))
  tv = new Tv(mediaDir)
  tv.addSeries('The Show', 'The Show', 2021, ['tv-14', '## - bob'])
  tv.addEpisode(0, 'The Show - S01E01 - Pilot.mkv', 'pilot data')
  tv.addEpisode(0, 'The Show - S01E02 - Second.mkv', 'second data')
  tv.addSeries('Family Show', 'Family Show', 2019, ['kids'])
  tv.addEpisode(1, 'Family Show - S01E01 - Start.mkv', 'family data')
  tv.addSeries('Pending Show', 'Pending Show', 2023, ['4k']) // no files
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(mediaDir, { recursive: true, force: true })
})

describe('SonarrAdapter.ping', () => {
  it('returns the app name and version', async () => {
    stubSonarr(tv)
    const info = await new SonarrAdapter(mediaOrigin(), API_KEY, 5000).ping()
    expect(info).toEqual({ name: 'sonarr', version: VERSION })
  })

  it('throws AdapterError with status 401 for a bad API key', async () => {
    stubSonarr(tv)
    const err = await new SonarrAdapter(mediaOrigin(), 'nope', 5000)
      .ping()
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AdapterError)
    expect((err as AdapterError).status).toBe(401)
  })
})

describe('SonarrAdapter.fetchItems normalization', () => {
  it('includes only series with files on disk, with real inodes and translated tags', async () => {
    stubSonarr(tv)
    const items = await new SonarrAdapter(mediaOrigin(), API_KEY, 5000).fetchItems()

    expect(items.map((i) => i.id).sort((a, b) => a - b)).toEqual([1, 2])

    const show = items.find((i) => i.id === 1)!
    expect(show.title).toBe('The Show')
    expect(show.year).toBe(2021)
    expect(new Set(show.tags)).toEqual(new Set(['tv-14', '## - bob']))
    expect(show.path).toBe(join(mediaDir, 'The Show'))
    expect(show.files).toHaveLength(2)
    for (const f of show.files) {
      expect(f.inode).not.toBeNull()
      expect(f.relPath).toBeTruthy()
    }

    const family = items.find((i) => i.id === 2)!
    expect(new Set(family.tags)).toEqual(new Set(['kids']))
    expect(family.files[0].relPath).toBe('Family Show - S01E01 - Start.mkv')
  })

  it("unions episode files' own audio languages, distinct from originalLanguage", async () => {
    tv.series[0].files = [] // The Show, re-added below with per-episode languages
    tv.addEpisode(0, 'The Show - S01E01 - Pilot.mkv', 'pilot data', ['English'])
    tv.addEpisode(0, 'The Show - S01E02 - Second.mkv', 'second data', [
      'English',
      'Spanish',
    ])
    stubSonarr(tv)
    const items = await new SonarrAdapter(mediaOrigin(), API_KEY, 5000).fetchItems()
    const show = items.find((i) => i.id === 1)!
    expect(new Set(show.audioLanguages)).toEqual(new Set(['English', 'Spanish']))
  })

  it('leaves audioLanguages undefined (not []) when the delta-fetch skips episodefile', async () => {
    tv.series[0].files = []
    tv.addEpisode(0, 'The Show - S01E01 - Pilot.mkv', 'pilot data', ['English'])
    stubSonarr(tv)
    const adapter = new SonarrAdapter(mediaOrigin(), API_KEY, 5000)
    const first = await adapter.fetchItems()
    const known = new Map(first.map((i) => [i.id, i.statsFingerprint!]))

    const second = await adapter.fetchItems(known)
    const show = second.find((i) => i.id === 1)!
    expect(show.filesStale).toBe(true)
    expect(show.audioLanguages).toBeUndefined()
  })

  it('drops an unknown tag id instead of leaking it as a literal string', async () => {
    tv.series[0].tags.push(999)
    stubSonarr(tv)
    const items = await new SonarrAdapter(mediaOrigin(), API_KEY, 5000).fetchItems()
    const show = items.find((i) => i.id === 1)!
    expect(show.tags).not.toContain('999')
    expect(new Set(show.tags)).toEqual(new Set(['tv-14', '## - bob']))
  })
})

describe('delta fetch', () => {
  it('skips /episodefile for series whose stored fingerprint is unchanged', async () => {
    stubSonarr(tv)
    const adapter = new SonarrAdapter(mediaOrigin(), API_KEY, 5000)

    // First poll: no known fingerprints -> every series with files is fetched.
    const first = await adapter.fetchItems()
    expect(tv.episodefileCalls).toEqual(expect.arrayContaining([1, 2]))
    const known = new Map(first.map((i) => [i.id, i.statsFingerprint!]))

    // Second poll: fingerprints match -> neither is re-fetched, both come
    // back stale (poller rehydrates from stored rows).
    tv.episodefileCalls = []
    const second = await adapter.fetchItems(known)
    expect(tv.episodefileCalls).not.toContain(1)
    expect(tv.episodefileCalls).not.toContain(2)
    expect(second.find((i) => i.id === 1)?.filesStale).toBe(true)
    expect(second.find((i) => i.id === 2)?.filesStale).toBe(true)

    // Adding an episode changes series 1's fingerprint -> it refetches
    // (series 3, "Pending Show", has no files and so never gets a stored
    // fingerprint -- it's always re-checked, same as the Python fixture's
    // `{1, 2} <= set(episodefile_calls)` subset assertion; series 2 stays
    // unchanged and must NOT be refetched).
    tv.addEpisode(0, 'The Show - S01E03 - Third.mkv', 'third data')
    tv.episodefileCalls = []
    const third = await adapter.fetchItems(known)
    expect(tv.episodefileCalls).toContain(1)
    expect(tv.episodefileCalls).not.toContain(2)
    expect(third.find((i) => i.id === 1)?.files).toHaveLength(3)
  })
})

function mediaOrigin(): string {
  return 'http://sonarr.local'
}
