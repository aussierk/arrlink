import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type AppContext } from '../../src/app.js'
import { loadSettings } from '../../src/config/env.js'
import { appItems } from '../../src/db/schema.js'

let dir: string
let ctx: AppContext
let appId: number

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Fake Radarr backing GET/PUT tag + tag/movie endpoints -- enough for
 * api/items.ts's tag-resolution and setItemTags calls. */
function stubRadarr(movies: Array<{ id: number; title: string; tags: number[] }>): void {
  const tags = [{ id: 1, label: 'kids', count: 1 }]
  let nextTagId = 2
  const fetchMock = vi.fn((url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url))
    if (u.pathname === '/api/v3/tag' && (!init || init.method === undefined)) {
      return Promise.resolve(jsonResponse(tags))
    }
    if (u.pathname === '/api/v3/tag' && init?.method === 'POST') {
      const body = JSON.parse(init.body as string) as { label: string }
      tags.push({ id: nextTagId++, label: body.label, count: 0 })
      return Promise.resolve(jsonResponse(tags[tags.length - 1], 201))
    }
    const movieMatch = /^\/api\/v3\/movie\/(\d+)$/.exec(u.pathname)
    if (movieMatch) {
      const id = Number(movieMatch[1])
      const movie = movies.find((m) => m.id === id)
      if (!movie) return Promise.resolve(new Response('not found', { status: 404 }))
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body as string) as { tags: number[] }
        movie.tags = body.tags
        return Promise.resolve(jsonResponse(body))
      }
      return Promise.resolve(jsonResponse(movie))
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  })
  vi.stubGlobal('fetch', fetchMock)
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-api-items-'))
  const settings = await loadSettings({ CONFIG_DIR: dir })
  ctx = await createApp(settings)
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/apps',
    payload: { name: 'Radarr', type: 'radarr', url: 'http://radarr.local', api_key: 'k' },
  })
  appId = res.json<{ id: number }>().id
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await ctx.close()
  rmSync(dir, { recursive: true, force: true })
})

function seedItem(itemId: number, title: string, tags: string[]): void {
  const now = Date.now() / 1000
  ctx.db
    .insert(appItems)
    .values({
      appId,
      itemId,
      title,
      year: 2020,
      tagsJson: JSON.stringify(tags),
      firstSeen: now,
      lastSeen: now,
    })
    .run()
}

describe('GET /api/apps/:appId/items', () => {
  it('lists items with parsed tags', async () => {
    seedItem(1, 'Inception', ['kids'])
    seedItem(2, 'Другой фильм', [])

    const res = await ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}/items` })
    expect(res.statusCode).toBe(200)
    const items = res.json<Array<{ title: string; tags: string[] }>>()
    expect(items.map((i) => i.title).sort()).toEqual(['Inception', 'Другой фильм'])
    expect(items.find((i) => i.title === 'Inception')?.tags).toEqual(['kids'])
  })

  it('404s for an unknown app', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/apps/999/items' })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /api/apps/:appId/items/tags', () => {
  it('adds an existing tag and removes another in one call', async () => {
    seedItem(1, 'Inception', ['kids'])
    const listBefore = await ctx.app.inject({
      method: 'GET',
      url: `/api/apps/${appId}/items`,
    })
    const itemDbId = listBefore.json<Array<{ id: number }>>()[0].id
    stubRadarr([{ id: 1, title: 'Inception', tags: [1] }])

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/apps/${appId}/items/tags`,
      payload: { item_ids: [itemDbId], add: ['4k'], remove: ['kids'] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ ok: number; failed: number }>()
    expect(body.ok).toBe(1)
    expect(body.failed).toBe(0)

    const listAfter = await ctx.app.inject({
      method: 'GET',
      url: `/api/apps/${appId}/items`,
    })
    expect(listAfter.json<Array<{ tags: string[] }>>()[0].tags).toEqual(['4k'])

    // the brand-new "4k" label reached the shared repository too
    const repo = await ctx.app.inject({ method: 'GET', url: '/api/tags' })
    expect(repo.json<Array<{ label: string }>>().map((t) => t.label)).toContain('4k')
  })

  it('reports a per-item failure without failing the whole batch', async () => {
    seedItem(1, 'Inception', [])
    const list = await ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}/items` })
    const itemDbId = list.json<Array<{ id: number }>>()[0].id
    // Radarr knows no movie with id 1 -- setItemTags's GET 404s.
    stubRadarr([])

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/apps/${appId}/items/tags`,
      payload: { item_ids: [itemDbId], add: ['kids'], remove: [] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      ok: number
      failed: number
      results: Array<{ item_id: number; ok: boolean }>
    }>()
    expect(body.failed).toBe(1)
    expect(body.results[0].ok).toBe(false)
  })

  it('422s when both add and remove are empty', async () => {
    seedItem(1, 'Inception', [])
    const list = await ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}/items` })
    const itemDbId = list.json<Array<{ id: number }>>()[0].id

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/apps/${appId}/items/tags`,
      payload: { item_ids: [itemDbId], add: [], remove: [] },
    })
    expect(res.statusCode).toBe(422)
  })
})
