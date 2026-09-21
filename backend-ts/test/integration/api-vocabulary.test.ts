import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppContext } from '../../src/app.js'
import { loadSettings } from '../../src/config/env.js'
import { vocabulary as vocabularyTable } from '../../src/db/schema.js'

let dir: string
let ctx: AppContext

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-api-vocab-'))
  const settings = await loadSettings({ CONFIG_DIR: dir })
  ctx = await createApp(settings)
})

afterEach(async () => {
  await ctx.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/vocabulary', () => {
  it('422s for a non-rich category', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/vocabulary?category=custom&app_type=radarr',
    })
    expect(res.statusCode).toBe(422)
  })

  it('returns shared vocabulary rows for a scope', async () => {
    ctx.db
      .insert(vocabularyTable)
      .values({
        category: 'genre',
        appType: 'radarr',
        appId: null,
        value: 'Horror',
        source: 'tmdb',
        importedAt: 0,
      })
      .run()
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/vocabulary?category=genre&app_type=radarr',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json<Array<{ value: string }>>().map((r) => r.value)).toEqual(['Horror'])
  })
})

describe('POST /api/vocabulary/import/tmdb', () => {
  it('422s when no TMDB key is configured', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/vocabulary/import/tmdb',
    })
    expect(res.statusCode).toBe(422)
  })
})

describe('POST /api/vocabulary/import/trash', () => {
  it('422s for an invalid app_type', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/vocabulary/import/trash?app_type=nope',
    })
    expect(res.statusCode).toBe(422)
  })
})
