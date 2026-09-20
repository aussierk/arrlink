import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppContext } from '../../src/app.js'
import { loadSettings } from '../../src/config/env.js'

let dir: string
let ctx: AppContext

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-app-smoke-'))
  const settings = await loadSettings({ CONFIG_DIR: dir })
  ctx = await createApp(settings)
})

afterEach(async () => {
  await ctx.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('app smoke', () => {
  it('GET /api/health reports ok with a schema version', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ status: string; db: string; schemaVersion: string | null }>()
    expect(body.status).toBe('ok')
    expect(body.db).toBe('ok')
    expect(body.schemaVersion).toBeTruthy()
  })

  it('sets hardening headers on every response, including 404s', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' })
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['referrer-policy']).toBe('no-referrer')
    expect(res.headers['x-frame-options']).toBe('DENY')
    expect(res.headers['cross-origin-opener-policy']).toBe('same-origin')
    expect(res.headers['content-security-policy']).toContain("default-src 'self'")

    const notFound = await ctx.app.inject({ method: 'GET', url: '/api/does-not-exist' })
    expect(notFound.headers['x-content-type-options']).toBe('nosniff')
  })

  it('refuses to start when another (external) process already holds the instance lock', async () => {
    // A second createApp() call in *this* process is expected to share the
    // lock via the refcounted registry (see singleton.test.ts) -- that's
    // not a conflict. A genuinely external holder is simulated here with a
    // raw proper-lockfile lock on the same lock path, bypassing our
    // in-process registry entirely.
    const externalDir = mkdtempSync(join(tmpdir(), 'arrlink-app-smoke-external-'))
    const lockPath = join(externalDir, 'arrlink.lock')
    const release = await lockfile.lock(lockPath, {
      realpath: false,
      stale: 30_000,
      retries: 0,
    })

    const settings = await loadSettings({ CONFIG_DIR: externalDir })
    await expect(createApp(settings)).rejects.toThrow(/already holds the lock/)

    await release()
    rmSync(externalDir, { recursive: true, force: true })
  })
})
