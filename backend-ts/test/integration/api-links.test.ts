import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppContext } from '../../src/app.js'
import { loadSettings } from '../../src/config/env.js'
import {
  appFiles,
  appItems,
  links as linksTable,
  rules as rulesTable,
} from '../../src/db/schema.js'
import { createLink } from '../../src/core/fsutil.js'

let dir: string
let mediaDir: string
let linkedDir: string
let ctx: AppContext
let appId: number

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-api-links-'))
  mediaDir = join(dir, 'media')
  linkedDir = join(dir, 'linked')
  mkdirSync(mediaDir, { recursive: true })
  mkdirSync(linkedDir, { recursive: true })
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

function seedLink(): { linkId: number; dst: string; src: string } {
  const db = ctx.db
  const ruleId = db.insert(rulesTable).values({ name: 'r', dirTemplate: linkedDir }).run()
    .lastInsertRowid as number
  const itemId = db
    .insert(appItems)
    .values({ appId, itemId: 1, title: 'T', firstSeen: 0, lastSeen: 0 })
    .run().lastInsertRowid as number
  const fileId = db
    .insert(appFiles)
    .values({ itemId, relPath: 'a.mkv', absPath: join(mediaDir, 'a.mkv') })
    .run().lastInsertRowid as number
  const src = join(mediaDir, 'a.mkv')
  const dst = join(linkedDir, 'a.mkv')
  writeFileSync(src, 'hello')
  createLink(src, dst, 'skip')
  const linkId = db
    .insert(linksTable)
    .values({
      ruleId,
      appId,
      itemId,
      fileId,
      srcPath: src,
      dstPath: dst,
      status: 'active',
      createdAt: Date.now() / 1000,
      matchKey: '',
    })
    .run().lastInsertRowid as number
  return { linkId, dst, src }
}

describe('GET /api/links', () => {
  it('lists links with total/limit/offset and filters by status', async () => {
    seedLink()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/links' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      items: unknown[]
      total: number
      limit: number
      offset: number
    }>()
    expect(body.total).toBe(1)
    expect(body.items).toHaveLength(1)

    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/api/links?status=missing',
    })
    expect(missing.json<{ total: number }>().total).toBe(0)
  })
})

describe('DELETE /api/links/:linkId', () => {
  it('removes the file from disk and marks the row missing', async () => {
    const { linkId, dst } = seedLink()
    expect(existsSync(dst)).toBe(true)
    const res = await ctx.app.inject({ method: 'DELETE', url: `/api/links/${linkId}` })
    expect(res.statusCode).toBe(204)
    expect(existsSync(dst)).toBe(false)
    const row = ctx.db.select().from(linksTable).where(eq(linksTable.id, linkId)).get()
    expect(row?.status).toBe('missing')
  })

  it('404s for an unknown link', async () => {
    const res = await ctx.app.inject({ method: 'DELETE', url: '/api/links/999' })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /api/links/repair', () => {
  it('re-creates a link whose destination vanished but whose source survives', async () => {
    const { dst, src } = seedLink()
    rmSync(dst)
    expect(existsSync(dst)).toBe(false)
    expect(existsSync(src)).toBe(true)

    const res = await ctx.app.inject({ method: 'POST', url: '/api/links/repair' })
    expect(res.statusCode).toBe(200)
    expect(res.json<{ fixed: number; failed: number }>()).toEqual({ fixed: 1, failed: 0 })
    expect(existsSync(dst)).toBe(true)
  })
})
