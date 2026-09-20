import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppContext } from '../../src/app.js'
import { loadSettings } from '../../src/config/env.js'

let dir: string
let ctx: AppContext

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-api-presets-'))
  const settings = await loadSettings({ CONFIG_DIR: dir })
  ctx = await createApp(settings)
})

afterEach(async () => {
  await ctx.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/presets', () => {
  it('lists presets for a valid app_type', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/presets?appType=radarr',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ presets: Array<{ key: string }> }>()
    expect(body.presets.length).toBeGreaterThan(0)
  })

  it('422s for an invalid app_type', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/presets?appType=nope' })
    expect(res.statusCode).toBe(422)
  })
})

describe('POST /api/presets/apply', () => {
  it('creates an editable rule from a preset', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/presets/apply',
      payload: { presetKey: 'kids', appType: 'radarr' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json<{ rule: { dirTemplate: string } }>()
    expect(body.rule.dirTemplate).toBe('/media/movies/kids')

    const list = await ctx.app.inject({ method: 'GET', url: '/api/rules' })
    expect(list.json<unknown[]>()).toHaveLength(1)
  })

  it('rejects a base_folder outside the allowed roots', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/presets/apply',
      payload: { presetKey: 'kids', appType: 'radarr', baseFolder: '/etc' },
    })
    expect(res.statusCode).toBe(422)
  })

  it('422s for an unknown preset key', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/presets/apply',
      payload: { presetKey: 'does-not-exist', appType: 'radarr' },
    })
    expect(res.statusCode).toBe(422)
  })
})
