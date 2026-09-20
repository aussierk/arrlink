import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type AppContext } from '../../src/app.js'
import { loadSettings } from '../../src/config/env.js'

let dir: string
let ctx: AppContext

afterEach(async () => {
  await ctx.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('trustProxy (FORWARDED_ALLOW_IPS)', () => {
  it('honors X-Forwarded-Proto from the default-trusted loopback peer', async () => {
    dir = mkdtempSync(join(tmpdir(), 'arrlink-trust-proxy-'))
    const settings = await loadSettings({ CONFIG_DIR: dir })
    ctx = await createApp(settings)

    ctx.app.get('/__proto', (request) => ({ protocol: request.protocol }))
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/__proto',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-proto': 'https' },
    })
    expect(res.json<{ protocol: string }>().protocol).toBe('https')
  })

  it('ignores X-Forwarded-Proto from an untrusted peer', async () => {
    dir = mkdtempSync(join(tmpdir(), 'arrlink-trust-proxy-'))
    const settings = await loadSettings({ CONFIG_DIR: dir })
    ctx = await createApp(settings)

    ctx.app.get('/__proto', (request) => ({ protocol: request.protocol }))
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/__proto',
      remoteAddress: '203.0.113.5',
      headers: { 'x-forwarded-proto': 'https' },
    })
    expect(res.json<{ protocol: string }>().protocol).toBe('http')
  })

  it('trusts a configured reverse-proxy CIDR', async () => {
    dir = mkdtempSync(join(tmpdir(), 'arrlink-trust-proxy-'))
    const settings = await loadSettings({
      CONFIG_DIR: dir,
      FORWARDED_ALLOW_IPS: '10.0.0.0/8',
    })
    ctx = await createApp(settings)

    ctx.app.get('/__proto', (request) => ({ protocol: request.protocol }))
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/__proto',
      remoteAddress: '10.1.2.3',
      headers: { 'x-forwarded-proto': 'https' },
    })
    expect(res.json<{ protocol: string }>().protocol).toBe('https')
  })
})
