import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppContext } from '../../src/app.js'
import { loadSettings } from '../../src/config/env.js'

let dir: string
let ctx: AppContext
let appId: number

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-api-tags-'))
  const settings = await loadSettings({ CONFIG_DIR: dir })
  ctx = await createApp(settings)
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/apps',
    payload: { name: 'Radarr', type: 'radarr', url: 'http://x', api_key: 'k' },
  })
  appId = res.json<{ id: number }>().id
})

afterEach(async () => {
  await ctx.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('POST /api/apps/:appId/tags/import-manual', () => {
  it('imports labels and lists them back with rule_count/count', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/apps/${appId}/tags/import-manual`,
      payload: { labels: ['kids', 'kids', ' ', 'family'], counts: { kids: 3 } },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json<{ imported: number }>().imported).toBe(4)

    const list = await ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}/tags` })
    const tags = list.json<Array<{ label: string; count: number; rule_count: number }>>()
    expect(tags.map((t) => t.label).sort()).toEqual(['family', 'kids'])
    expect(tags.find((t) => t.label === 'kids')?.count).toBe(3)
  })

  it('404s for an unknown app', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/apps/999/tags/import-manual',
      payload: { labels: ['x'] },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('PATCH /api/apps/:appId/tags/:tagId/category', () => {
  it('classifies a tag and rejects an unknown category', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/api/apps/${appId}/tags/import-manual`,
      payload: { labels: ['kids'] },
    })
    const list = await ctx.app.inject({ method: 'GET', url: `/api/apps/${appId}/tags` })
    const tagId = list.json<Array<{ id: number }>>()[0].id

    const bad = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/apps/${appId}/tags/${tagId}/category`,
      payload: { category: 'not-a-category' },
    })
    expect(bad.statusCode).toBe(422)

    const ok = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/apps/${appId}/tags/${tagId}/category`,
      payload: { category: 'genre' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json<{ category: string }>().category).toBe('genre')
  })
})

describe('tag repository', () => {
  it('upserts, lists, and deletes a repository entry', async () => {
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/tags',
      payload: { label: 'family' },
    })
    expect(put.statusCode).toBe(200)

    const list = await ctx.app.inject({ method: 'GET', url: '/api/tags' })
    expect(list.json<Array<{ label: string }>>().map((t) => t.label)).toEqual(['family'])

    const del = await ctx.app.inject({ method: 'DELETE', url: '/api/tags/family' })
    expect(del.statusCode).toBe(204)

    const again = await ctx.app.inject({ method: 'DELETE', url: '/api/tags/family' })
    expect(again.statusCode).toBe(404)
  })
})

describe('POST /api/tags/push', () => {
  it('reports a failure for an unreachable app without throwing', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/tags/push',
      payload: { label: 'family', app_ids: [appId] },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ ok: number; failed: number }>()
    expect(body.failed).toBe(1)
    expect(body.ok).toBe(0)
  })
})
