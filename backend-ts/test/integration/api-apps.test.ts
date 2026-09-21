import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppContext } from '../../src/app.js'
import { loadSettings } from '../../src/config/env.js'

let dir: string
let ctx: AppContext

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-api-apps-'))
  const settings = await loadSettings({ CONFIG_DIR: dir })
  ctx = await createApp(settings)
})

afterEach(async () => {
  await ctx.close()
  rmSync(dir, { recursive: true, force: true })
})

async function createApp1(): Promise<{ id: number; api_key_masked: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/apps',
    payload: {
      name: 'Radarr',
      type: 'radarr',
      url: 'radarr.local:7878',
      api_key: 'supersecretkey',
    },
  })
  return res.json()
}

describe('POST /api/apps', () => {
  it('creates an app, normalizes the URL, and masks the key', async () => {
    const body = await createApp1()
    expect(body.api_key_masked).toBe('••••tkey')

    const res = await ctx.app.inject({ method: 'GET', url: `/api/apps/${body.id}` })
    const got = res.json<{ url: string; enabled: boolean }>()
    expect(got.url).toBe('http://radarr.local:7878')
    expect(got.enabled).toBe(true)
  })

  it('rejects an empty api_key', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/apps',
      payload: { name: 'Radarr', type: 'radarr', url: 'http://x', api_key: '' },
    })
    expect(res.statusCode).toBe(422)
  })
})

describe('GET /api/apps/summary', () => {
  it('reports zeroed link counts with no orphaned rules initially', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/apps/summary' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ active_links: number; orphaned_rules: string[] }>()
    expect(body.active_links).toBe(0)
    expect(body.orphaned_rules).toEqual([])
  })
})

describe('PATCH /api/apps/:appId', () => {
  it('keeps the existing api_key when the update sends a blank one', async () => {
    const created = await createApp1()
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/apps/${created.id}`,
      payload: { name: 'Radarr HD', type: 'radarr', url: 'http://x', api_key: '' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ api_key_masked: string }>().api_key_masked).toBe('••••tkey')
  })

  it('404s for an unknown app', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/apps/999',
      payload: { name: 'x', type: 'radarr', url: 'http://x', api_key: 'k' },
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /api/apps/:appId', () => {
  it('deletes an app and 404s on a repeat delete', async () => {
    const created = await createApp1()
    const res = await ctx.app.inject({ method: 'DELETE', url: `/api/apps/${created.id}` })
    expect(res.statusCode).toBe(204)
    const again = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/apps/${created.id}`,
    })
    expect(again.statusCode).toBe(404)
  })
})

describe('POST /api/apps/:appId/rescan', () => {
  it('502s with the poll error when the app is unreachable', async () => {
    const created = await createApp1()
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/apps/${created.id}/rescan`,
    })
    expect(res.statusCode).toBe(502)
  })

  it('404s for an unknown app', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/apps/999/rescan' })
    expect(res.statusCode).toBe(404)
  })
})
