import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, type AppContext } from '../../src/app.js'
import { hashPassword } from '../../src/auth/passwords.js'
import * as lockout from '../../src/auth/lockout.js'
import { loadSettings } from '../../src/config/env.js'

let dir: string
let ctx: AppContext

async function bootWithPassword(password: string): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-auth-pw-'))
  const settings = await loadSettings({
    CONFIG_DIR: dir,
    AUTH_PASSWORD_ENABLED: '1',
    UI_USERNAME: 'admin',
    UI_PASSWORD: password,
  })
  ctx = await createApp(settings)
}

afterEach(async () => {
  await ctx.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('GET /api/auth/me', () => {
  it('never 401s and reports auth mode + unauthenticated state', async () => {
    await bootWithPassword('correct-horse')
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/me' })
    expect(res.statusCode).toBe(200)
    const body = res.json<{ authenticated: boolean; password_enabled: boolean }>()
    expect(body.authenticated).toBe(false)
    expect(body.password_enabled).toBe(true)
  })

  it('reports authenticated: true when auth is entirely disabled', async () => {
    dir = mkdtempSync(join(tmpdir(), 'arrlink-auth-pw-'))
    const settings = await loadSettings({ CONFIG_DIR: dir })
    ctx = await createApp(settings)
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/me' })
    expect(res.json<{ authenticated: boolean }>().authenticated).toBe(true)
  })
})

describe('POST /api/auth/password', () => {
  it('rejects when password login is not enabled', async () => {
    dir = mkdtempSync(join(tmpdir(), 'arrlink-auth-pw-'))
    const settings = await loadSettings({ CONFIG_DIR: dir })
    ctx = await createApp(settings)
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { username: 'admin', password: 'x' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('sets a session cookie and redirects on correct credentials', async () => {
    await bootWithPassword('correct-horse')
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { username: 'admin', password: 'correct-horse' },
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers['set-cookie']).toMatch(/arrlink_pw=/)

    const cookie = res.cookies.find((c) => c.name === 'arrlink_pw')
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { arrlink_pw: cookie!.value },
    })
    expect(me.json<{ authenticated: boolean; email: string }>()).toMatchObject({
      authenticated: true,
      email: 'admin',
    })
  })

  it('rejects the wrong password without revealing which field was wrong', async () => {
    await bootWithPassword('correct-horse')
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { username: 'admin', password: 'wrong' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json<{ detail: string }>().detail).toBe('wrong username or password')
  })

  it('rejects the wrong username identically to a wrong password', async () => {
    await bootWithPassword('correct-horse')
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { username: 'not-admin', password: 'correct-horse' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('locks out after repeated failures and rejects even the correct password while locked', async () => {
    await bootWithPassword('correct-horse')
    for (let i = 0; i < lockout.THRESHOLD; i++) {
      await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/password',
        payload: { username: 'admin', password: 'wrong' },
      })
    }
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { username: 'admin', password: 'correct-horse' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('422s on a malformed body instead of 500ing', async () => {
    await bootWithPassword('correct-horse')
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { username: '', password: '' },
    })
    expect(res.statusCode).toBe(422)
  })
})

describe('POST /api/auth/password/unlock', () => {
  it('requires an authenticated session', async () => {
    await bootWithPassword('correct-horse')
    const res = await ctx.app.inject({ method: 'POST', url: '/api/auth/password/unlock' })
    expect(res.statusCode).toBe(401)
  })

  it('clears an active lockout given a valid session', async () => {
    await bootWithPassword('correct-horse')
    for (let i = 0; i < lockout.THRESHOLD; i++) {
      await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/password',
        payload: { username: 'admin', password: 'wrong' },
      })
    }
    expect(lockout.status(ctx.db, 'admin').locked).toBe(true)

    // Log in via a still-valid session created directly (simulating an
    // OIDC session obtained through a different channel).
    const { createSession } = await import('../../src/auth/sessions.js')
    const { token } = createSession(ctx.db, 'admin', 'admin', [], null, 1, 'password')

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password/unlock',
      cookies: { arrlink_pw: token },
    })
    expect(res.statusCode).toBe(200)
    expect(lockout.status(ctx.db, 'admin').locked).toBe(false)
  })
})

describe('POST /api/auth/logout', () => {
  it('revokes the session and clears cookies', async () => {
    await bootWithPassword('correct-horse')
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { username: 'admin', password: 'correct-horse' },
    })
    const cookie = login.cookies.find((c) => c.name === 'arrlink_pw')!.value

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { arrlink_pw: cookie },
    })
    expect(res.statusCode).toBe(302)

    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { arrlink_pw: cookie },
    })
    expect(me.json<{ authenticated: boolean }>().authenticated).toBe(false)
  })
})

describe('password hash compatibility', () => {
  it('accepts a password whose hash was produced by hashPassword directly (Argon2id)', async () => {
    const hash = await hashPassword('super-secret')
    dir = mkdtempSync(join(tmpdir(), 'arrlink-auth-pw-'))
    const settings = await loadSettings({ CONFIG_DIR: dir, AUTH_PASSWORD_ENABLED: '1' })
    ctx = await createApp(settings)
    // Directly set the pre-hashed password via the settings override layer,
    // the same path Settings > Authentication uses.
    const { SettingsStore } = await import('../../src/db/settings-store.js')
    new SettingsStore(ctx.db).setSetting('auth_password', hash)

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      payload: { username: 'admin', password: 'super-secret' },
    })
    expect(res.statusCode).toBe(302)
  })
})
