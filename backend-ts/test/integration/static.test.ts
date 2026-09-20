import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppContext } from '../../src/app.js'
import { loadSettings } from '../../src/config/env.js'

// These tests need a real built `web/dist` (gitignored, produced by `npm run
// build` in web/) -- skip gracefully rather than fail on a fresh checkout/CI
// box that never built the frontend.
const webDistDir = join(process.cwd(), '..', 'web', 'dist')
const hasWebDist = existsSync(join(webDistDir, 'index.html'))
const oneAsset = hasWebDist
  ? readdirSync(join(webDistDir, 'assets')).find((f) => f.endsWith('.js'))
  : undefined

let dir: string
let ctx: AppContext

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-static-'))
  const settings = await loadSettings({ CONFIG_DIR: dir })
  ctx = await createApp(settings)
})

afterEach(async () => {
  await ctx.close()
  rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(!hasWebDist)('static/SPA serving', () => {
  it('serves a real fingerprinted asset as-is', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/assets/${oneAsset}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('javascript')
  })

  it('falls back to index.html for a client-routed SPA path, with no-cache', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/rules' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.headers['cache-control']).toBe('no-cache')
    expect(res.payload).toContain('<html')
  })

  it('falls back to index.html for an unmatched /api path too, matching main.py parity', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/does-not-exist' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
  })

  it('never serves index.html itself with long-lived caching', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/index.html' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache')
  })

  it('never leaks a file outside dist for a path-traversal attempt (falls back to the SPA)', async () => {
    // Fastify's router normalizes ".." segments before the handler ever sees
    // them, so this can't literally escape `dist` -- assert no leak rather
    // than a specific status, since the normalized path harmlessly 404s into
    // the same index.html fallback as any other unknown route.
    const res = await ctx.app.inject({ method: 'GET', url: '/../../../../etc/passwd' })
    expect(res.payload).not.toContain('root:')
    expect(res.headers['content-type']).toContain('text/html')
  })

  it('still applies security headers on static/SPA responses', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/rules' })
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-security-policy']).toContain("default-src 'self'")
  })
})
