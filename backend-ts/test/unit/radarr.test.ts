import { afterEach, describe, expect, it, vi } from 'vitest'
import { AdapterError } from '../../src/arr/types.js'
import { RadarrAdapter } from '../../src/arr/radarr.js'

const API_KEY = 'radarr-key-123'
const VERSION = '5.16.0.1'

// Mirrors tests/test_radarr_adapter.py's build_radarr() fixture, but
// serves the fake Radarr via a fetch mock router instead of a real HTTP
// server -- no DB dependency, unit-testable in isolation (per the plan).
const TAGS = [
  { id: 1, label: 'kids', count: 2 },
  { id: 2, label: '## - alice', count: 1 },
  { id: 3, label: '4k', count: 1 },
]

const MOVIES = [
  {
    id: 1,
    title: 'Inception',
    year: 2010,
    tags: [3, 2], // 4k, ## - alice
    collection: { title: 'Inception Collection', tmdbId: 1 }, // Radarr sends `title`, not `name`
    movieFile: {
      path: '/media/movies/Inception.2010.2160p.mkv',
      size: 12345,
      languages: [{ id: 1, name: 'English' }],
    },
  },
  {
    id: 2,
    title: 'Pending Movie',
    year: 2020,
    tags: [1],
    movieFile: null, // not on disk -> excluded
  },
  {
    id: 3,
    title: 'Kids Movie',
    year: 2019,
    tags: [1],
    movieFile: { path: '/media/movies/Kids Movie/Kids Movie.2019.mkv', size: 999 },
  },
]

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function stubRadarr(apiKey: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    const headers = new Headers(init?.headers)
    if (headers.get('x-api-key') !== apiKey) {
      return Promise.resolve(jsonResponse({ error: 'Unauthorized' }, 401))
    }
    if (u.pathname === '/api/v3/system/status') {
      return Promise.resolve(jsonResponse({ version: VERSION, appName: 'Radarr' }))
    }
    if (u.pathname === '/api/v3/tag') {
      return Promise.resolve(jsonResponse(TAGS))
    }
    if (u.pathname === '/api/v3/movie') {
      return Promise.resolve(jsonResponse(MOVIES))
    }
    const movieMatch = /^\/api\/v3\/movie\/(\d+)$/.exec(u.pathname)
    if (movieMatch) {
      const id = Number(movieMatch[1])
      const movie = MOVIES.find((m) => m.id === id)
      if (!movie) return Promise.resolve(new Response('not found', { status: 404 }))
      if (init?.method === 'PUT') {
        return Promise.resolve(jsonResponse(JSON.parse(init.body as string)))
      }
      return Promise.resolve(jsonResponse(movie))
    }
    if (u.pathname === '/api/v3/qualityprofile') {
      return Promise.resolve(jsonResponse([]))
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RadarrAdapter.ping', () => {
  it('returns the app name and version', async () => {
    stubRadarr(API_KEY)
    const info = await new RadarrAdapter('http://radarr.local', API_KEY, 5000).ping()
    expect(info).toEqual({ name: 'radarr', version: VERSION })
  })

  it('throws AdapterError with status 401 for a bad API key', async () => {
    stubRadarr(API_KEY)
    const err = await new RadarrAdapter('http://radarr.local', 'nope', 5000)
      .ping()
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AdapterError)
    expect((err as AdapterError).status).toBe(401)
    expect((err as AdapterError).detail).toMatch(/bad API key/)
  })
})

describe('RadarrAdapter.fetchItems normalization', () => {
  it('includes only movies with a movieFile, translates tag ids, and derives path/rel_path', async () => {
    stubRadarr(API_KEY)
    const items = await new RadarrAdapter(
      'http://radarr.local',
      API_KEY,
      5000,
    ).fetchItems()

    // only movies with a movieFile
    expect(items.map((i) => i.id)).toEqual([1, 3])

    const inception = items[0]
    expect(inception.title).toBe('Inception')
    expect(inception.year).toBe(2010)
    expect(new Set(inception.tags)).toEqual(new Set(['4k', '## - alice']))
    expect(inception.path).toBe('/media/movies')
    expect(inception.files[0].absPath).toBe('/media/movies/Inception.2010.2160p.mkv')
    expect(inception.files[0].relPath).toBe('Inception.2010.2160p.mkv')
    // the file doesn't exist on this test machine, so size falls back to
    // the API-reported value and mtime/inode stay null
    expect(inception.files[0].size).toBe(12345)
    expect(inception.files[0].mtime).toBeNull()
    expect(inception.files[0].inode).toBeNull()
    // movieFile.languages -- the file's own audio track(s), distinct from
    // originalLanguage (the title's production language).
    expect(inception.audioLanguages).toEqual(['English'])
    expect(inception.collection).toBe('Inception Collection')

    const kids = items[1]
    expect(kids.path).toBe('/media/movies/Kids Movie')
    expect(kids.files[0].relPath).toBe('Kids Movie.2019.mkv')
  })
})

describe('createTag', () => {
  it('rejects an empty label without a network call', async () => {
    const fetchMock = stubRadarr(API_KEY)
    await expect(
      new RadarrAdapter('http://radarr.local', API_KEY, 5000).createTag('   '),
    ).rejects.toThrow(AdapterError)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('setItemTags', () => {
  it('GETs the current movie and PUTs it back with only tags replaced', async () => {
    const fetchMock = stubRadarr(API_KEY)
    await new RadarrAdapter('http://radarr.local', API_KEY, 5000).setItemTags(1, [1, 3])

    const putCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === 'PUT',
    ) as [string | URL, RequestInit] | undefined
    expect(putCall).toBeDefined()
    const [url, init] = putCall!
    expect(new URL(String(url)).pathname).toBe('/api/v3/movie/1')
    const body = JSON.parse(init.body as string) as { tags: number[]; title: string }
    expect(body.tags).toEqual([1, 3])
    // every other field from the GET response is preserved, not dropped
    expect(body.title).toBe('Inception')
  })

  it('throws AdapterError for an unknown item id', async () => {
    stubRadarr(API_KEY)
    await expect(
      new RadarrAdapter('http://radarr.local', API_KEY, 5000).setItemTags(999, [1]),
    ).rejects.toThrow(AdapterError)
  })
})
