import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppContext } from '../../src/app.js'
import { loadSettings } from '../../src/config/env.js'

let dir: string
let ctx: AppContext

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-api-backup-'))
  const settings = await loadSettings({ CONFIG_DIR: dir })
  ctx = await createApp(settings)
})

afterEach(async () => {
  await ctx.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('backup settings + run', () => {
  it('reports defaults, accepts an update, and runs a manual backup', async () => {
    const before = await ctx.app.inject({ method: 'GET', url: '/api/backup/settings' })
    expect(before.json<{ enabled: boolean }>().enabled).toBe(true)

    const put = await ctx.app.inject({
      method: 'PUT',
      url: '/api/backup/settings',
      payload: { enabled: false, retentionDays: 3, intervalHours: 12 },
    })
    expect(put.statusCode).toBe(200)
    expect(put.json()).toEqual({ enabled: false, retentionDays: 3, intervalHours: 12 })

    const run = await ctx.app.inject({ method: 'POST', url: '/api/backup/run' })
    expect(run.statusCode).toBe(200)
    expect(run.json<{ ok: boolean }>().ok).toBe(true)

    const list = await ctx.app.inject({ method: 'GET', url: '/api/backup' })
    expect(list.json<unknown[]>()).toHaveLength(1)
  })
})
