import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppContext } from '../../src/app.js'
import { loadSettings } from '../../src/config/env.js'
import { logEvent } from '../../src/db/events.js'

let dir: string
let ctx: AppContext

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-api-logs-'))
  const settings = await loadSettings({ CONFIG_DIR: dir })
  ctx = await createApp(settings)
})

afterEach(async () => {
  await ctx.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('POST /api/logs', () => {
  it('records a client-reported error into the event log', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/logs',
      payload: {
        message: 'boom',
        level: 'error',
        url: '/rules',
        stack: 'Error: boom\nat x',
      },
    })
    expect(res.statusCode).toBe(204)

    const list = await ctx.app.inject({ method: 'GET', url: '/api/logs' })
    const rows = list.json<Array<{ message: string; level: string }>>()
    expect(
      rows.some((r) => r.level === 'error' && r.message.includes('[web] boom')),
    ).toBe(true)
  })
})

describe('GET /api/logs', () => {
  it('filters by level and respects limit', async () => {
    logEvent(ctx.db, 'info', 'one')
    logEvent(ctx.db, 'warn', 'two')
    const res = await ctx.app.inject({ method: 'GET', url: '/api/logs?level=warn' })
    const rows = res.json<Array<{ level: string; message: string }>>()
    expect(rows.every((r) => r.level === 'warn')).toBe(true)
    expect(rows.some((r) => r.message === 'two')).toBe(true)
  })
})

describe('GET /api/logs/stream', () => {
  it('yields a bounded snapshot and closes when limit is given', async () => {
    logEvent(ctx.db, 'info', 'one')
    logEvent(ctx.db, 'info', 'two')
    const res = await ctx.app.inject({ method: 'GET', url: '/api/logs/stream?limit=1' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.payload).toContain('data:')
  })
})
