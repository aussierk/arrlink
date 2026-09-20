import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppContext } from '../../src/app.js'
import { loadSettings } from '../../src/config/env.js'

let dir: string
let ctx: AppContext

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-api-settings-'))
  const settings = await loadSettings({ CONFIG_DIR: dir })
  ctx = await createApp(settings)
})

afterEach(async () => {
  await ctx.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('generic settings', () => {
  it('sets and deletes an arbitrary key', async () => {
    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/app_title',
      payload: { value: 'My ArrLink' },
    })
    expect(put.statusCode).toBe(200)
    expect(put.json<Record<string, unknown>>().app_title).toBe('My ArrLink')

    const del = await ctx.app.inject({ method: 'DELETE', url: '/api/settings/app_title' })
    expect(del.statusCode).toBe(204)
    const after = await ctx.app.inject({ method: 'GET', url: '/api/settings' })
    expect(after.json<Record<string, unknown>>().app_title).toBeUndefined()
  })

  it('rejects an invalid key and a protected key', async () => {
    const badKey = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/Not Valid!',
      payload: { value: 1 },
    })
    expect(badKey.statusCode).toBe(422)

    const protectedKey = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/auth_password',
      payload: { value: 'nope' },
    })
    expect(protectedKey.statusCode).toBe(403)
  })
})

describe('GET /api/settings/effective', () => {
  it('reports defaults with nothing overridden', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/settings/effective' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{
      allowedRoots: string[]
      fsFallback: string
      appTitle: string
    }>()
    expect(body.allowedRoots).toEqual(['/media'])
    expect(body.fsFallback).toBe('skip')
    expect(body.appTitle).toBe('ArrLink')
  })
})

describe('PUT /api/settings/auth', () => {
  it('refuses to enable password login with no password configured', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/auth',
      payload: { passwordEnabled: true },
    })
    expect(res.statusCode).toBe(422)
  })

  it('enables password login when a password is supplied in the same request', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/auth',
      payload: { passwordEnabled: true, uiPassword: 'correct-horse-battery' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ passwordEnabled: boolean; uiPasswordSet: boolean }>()
    expect(body.passwordEnabled).toBe(true)
    expect(body.uiPasswordSet).toBe(true)
  })
})

describe('PUT /api/settings/logging', () => {
  it('rejects an unknown log level', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/logging',
      payload: { logLevel: 'verbose', logSizeLimitMb: 10 },
    })
    expect(res.statusCode).toBe(422)
  })

  it('persists a valid level and size', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/api/settings/logging',
      payload: { logLevel: 'DEBUG', logSizeLimitMb: 25 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ logLevel: 'debug', logSizeLimitMb: 25 })
  })
})
