import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type AppContext } from '../../src/app.js'
import { loadSettings } from '../../src/config/env.js'

let dir: string
let ctx: AppContext | undefined

afterEach(async () => {
  if (ctx) await ctx.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('trusted-host', () => {
  it('passes through requests when TRUSTED_HOSTS is unset', async () => {
    dir = mkdtempSync(join(tmpdir(), 'arrlink-plugins-'))
    const settings = await loadSettings({ CONFIG_DIR: dir })
    ctx = await createApp(settings)
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
  })

  it('400s a request with an untrusted Host header, and allows a trusted one', async () => {
    dir = mkdtempSync(join(tmpdir(), 'arrlink-plugins-'))
    const settings = await loadSettings({
      CONFIG_DIR: dir,
      TRUSTED_HOSTS: 'arrlink.example.com',
    })
    ctx = await createApp(settings)

    const bad = await ctx.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'evil.example.com' },
    })
    expect(bad.statusCode).toBe(400)

    const good = await ctx.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'arrlink.example.com' },
    })
    expect(good.statusCode).toBe(200)

    // loopback hosts stay implicitly trusted regardless of TRUSTED_HOSTS
    const loopback = await ctx.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { host: 'localhost:8270' },
    })
    expect(loopback.statusCode).toBe(200)
  })
})

describe('dev CORS', () => {
  it('adds no CORS headers when ENABLE_DEV_CORS is unset', async () => {
    dir = mkdtempSync(join(tmpdir(), 'arrlink-plugins-'))
    const settings = await loadSettings({ CONFIG_DIR: dir })
    ctx = await createApp(settings)
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost:5173' },
    })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('echoes the Vite dev origin and answers a preflight when enabled', async () => {
    dir = mkdtempSync(join(tmpdir(), 'arrlink-plugins-'))
    const settings = await loadSettings({ CONFIG_DIR: dir, ENABLE_DEV_CORS: '1' })
    ctx = await createApp(settings)

    const get = await ctx.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://localhost:5173' },
    })
    expect(get.headers['access-control-allow-origin']).toBe('http://localhost:5173')

    const preflight = await ctx.app.inject({
      method: 'OPTIONS',
      url: '/api/health',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
      },
    })
    expect(preflight.statusCode).toBe(204)
    expect(preflight.headers['access-control-allow-methods']).toBe('POST')
  })

  it('ignores an origin outside the allow-list', async () => {
    dir = mkdtempSync(join(tmpdir(), 'arrlink-plugins-'))
    const settings = await loadSettings({ CONFIG_DIR: dir, ENABLE_DEV_CORS: '1' })
    ctx = await createApp(settings)
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://evil.example.com' },
    })
    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })
})
