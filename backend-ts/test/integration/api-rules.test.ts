import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppContext } from '../../src/app.js'
import { loadSettings } from '../../src/config/env.js'

let dir: string
let ctx: AppContext

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-api-rules-'))
  const settings = await loadSettings({ CONFIG_DIR: dir })
  ctx = await createApp(settings)
})

afterEach(async () => {
  await ctx.close()
  rmSync(dir, { recursive: true, force: true })
})

function ruleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'kids',
    dir_template: '/media/kids',
    conditions: [
      { category: 'user', match_type: 'exact', match_value: 'kids', join: null },
    ],
    ...overrides,
  }
}

describe('POST /api/rules', () => {
  it('creates a rule and returns vocabulary_warnings', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: ruleBody(),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json<{
      id: number
      conditions: unknown[]
      vocabulary_warnings: string[]
    }>()
    expect(body.conditions).toHaveLength(1)
    expect(body.vocabulary_warnings).toEqual([])
  })

  it('rejects a dir_template outside the allowed roots', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: ruleBody({ dir_template: '/etc/passwd' }),
    })
    expect(res.statusCode).toBe(422)
  })

  it('rejects an unknown placeholder', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: ruleBody({ dir_template: '/media/{$nope}' }),
    })
    expect(res.statusCode).toBe(422)
  })

  it('rejects a missing join operator on the second condition', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: ruleBody({
        conditions: [
          { category: 'user', match_type: 'exact', match_value: 'kids', join: null },
          { category: 'genre', match_type: 'exact', match_value: 'Comedy', join: null },
        ],
      }),
    })
    expect(res.statusCode).toBe(422)
  })

  it('rejects an invalid regex condition', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: ruleBody({
        conditions: [
          { category: 'user', match_type: 'regex', match_value: '(unclosed', join: null },
        ],
      }),
    })
    expect(res.statusCode).toBe(422)
  })
})

describe('GET/PATCH/DELETE /api/rules/:ruleId', () => {
  it('round-trips a rule through update and delete', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules',
      payload: ruleBody(),
    })
    const id = created.json<{ id: number }>().id

    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/rules/${id}`,
      payload: ruleBody({ name: 'kids v2', priority: 50 }),
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json<{ name: string; priority: number }>().priority).toBe(50)

    const list = await ctx.app.inject({ method: 'GET', url: '/api/rules' })
    expect(list.json<Array<{ id: number; link_count: number }>>()).toHaveLength(1)

    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/rules/${id}` })
    expect(del.statusCode).toBe(204)
    const get = await ctx.app.inject({ method: 'GET', url: `/api/rules/${id}` })
    expect(get.statusCode).toBe(404)
  })
})

describe('POST /api/rules/vocabulary-check', () => {
  it('returns an empty warning list with no vocabulary configured', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules/vocabulary-check',
      payload: ruleBody(),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ warnings: string[] }>().warnings).toEqual([])
  })
})

describe('POST /api/rules/preview', () => {
  it('404s for an unknown app', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/rules/preview?app_id=999',
      payload: ruleBody(),
    })
    expect(res.statusCode).toBe(404)
  })

  it('falls back to a live fetch and surfaces the adapter error when never polled', async () => {
    const appRes = await ctx.app.inject({
      method: 'POST',
      url: '/api/apps',
      payload: { name: 'Radarr', type: 'radarr', url: 'http://x', api_key: 'k' },
    })
    const appId = appRes.json<{ id: number }>().id
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/rules/preview?app_id=${appId}`,
      payload: ruleBody(),
    })
    expect(res.statusCode).toBe(502)
  })
})
