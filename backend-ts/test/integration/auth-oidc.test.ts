import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type AppContext } from '../../src/app.js'
import { loadSettings } from '../../src/config/env.js'
import { clearDiscoveryCache } from '../../src/auth/oidc.js'
import { SettingsStore } from '../../src/db/settings-store.js'

const DISCOVERY = {
  authorization_endpoint: 'https://idp.example.com/authorize',
  token_endpoint: 'https://idp.example.com/token',
  userinfo_endpoint: 'https://idp.example.com/userinfo',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url')
}

let dir: string
let ctx: AppContext

beforeEach(() => {
  clearDiscoveryCache()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await ctx.close()
  rmSync(dir, { recursive: true, force: true })
})

async function bootWithOidc(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-auth-oidc-'))
  const settings = await loadSettings({
    CONFIG_DIR: dir,
    AUTH_OIDC_ENABLED: '1',
    OIDC_ISSUER: 'https://idp.example.com',
    OIDC_CLIENT_ID: 'client-1',
    OIDC_CLIENT_SECRET: 'secret-1',
    APP_URL: 'https://arrlink.example.com',
  })
  ctx = await createApp(settings)
}

describe('GET /api/auth/login', () => {
  it('rejects when OIDC is not enabled', async () => {
    dir = mkdtempSync(join(tmpdir(), 'arrlink-auth-oidc-'))
    const settings = await loadSettings({ CONFIG_DIR: dir })
    ctx = await createApp(settings)
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/login' })
    expect(res.statusCode).toBe(400)
  })

  it('redirects to the authorization_endpoint with PKCE params and records login state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(DISCOVERY)))
    await bootWithOidc()
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/login' })
    expect(res.statusCode).toBe(302)
    const location = new URL(res.headers.location as string)
    expect(location.origin + location.pathname).toBe(DISCOVERY.authorization_endpoint)
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://arrlink.example.com/auth/oidc/callback',
    )
    expect(location.searchParams.get('state')).toBeTruthy()
  })
})

describe('GET /auth/oidc/callback', () => {
  async function startLogin(): Promise<{ state: string }> {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(DISCOVERY)))
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/login' })
    const location = new URL(res.headers.location as string)
    return { state: location.searchParams.get('state')! }
  }

  it('completes the flow: exchanges the code, validates the id_token, creates a session', async () => {
    await bootWithOidc()
    const { state } = await startLogin()

    // The nonce is internal to the login flow (recorded server-side in
    // oidc_logins), so read it back from the DB rather than guessing it.
    const row = ctx.db
      .select()
      .from((await import('../../src/db/schema.js')).oidcLogins)
      .get()
    const realIdToken = `h.${b64url({ nonce: row!.nonce, exp: 9999999999 })}.s`

    // The discovery cache is already warm from startLogin() (same issuer),
    // so the callback's own OidcClient.discovery() call is a cache hit --
    // only the token and userinfo calls actually hit fetch.
    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        access_token: 'at-1',
        id_token: realIdToken,
        refresh_token: 'rt-1',
      }),
    )
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ email: 'user@example.com', name: 'User' }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/auth/oidc/callback?code=abc&state=${state}`,
    })
    expect(res.statusCode).toBe(302)
    expect(res.cookies.map((c) => c.name)).toContain('arrlink_session')

    const cookie = res.cookies.find((c) => c.name === 'arrlink_session')!.value
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { arrlink_session: cookie },
    })
    expect(me.json<{ authenticated: boolean; email: string }>()).toMatchObject({
      authenticated: true,
      email: 'user@example.com',
    })
  })

  it('rejects an unknown or expired state', async () => {
    await bootWithOidc()
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/auth/oidc/callback?code=abc&state=not-a-real-state',
    })
    expect(res.statusCode).toBe(400)
  })

  it('sets arrlink_auth_error and redirects home when the provider reports an error', async () => {
    await bootWithOidc()
    const { state } = await startLogin()
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/auth/oidc/callback?error=access_denied&state=${state}`,
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers.location).toBe('/')
    expect(res.headers['set-cookie']).toMatch(/arrlink_auth_error=access_denied/)
  })

  it('rejects a nonce mismatch (possible replay)', async () => {
    await bootWithOidc()
    const { state } = await startLogin()
    const wrongNonceToken = `h.${b64url({ nonce: 'wrong-nonce', exp: 9999999999 })}.s`

    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at-1', id_token: wrongNonceToken }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/auth/oidc/callback?code=abc&state=${state}`,
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a login when the email is outside the allow-list', async () => {
    await bootWithOidc()
    new SettingsStore(ctx.db).setSetting('oidc_allowed_emails', [
      'someone-else@example.com',
    ])
    const { state } = await startLogin()

    const row = ctx.db
      .select()
      .from((await import('../../src/db/schema.js')).oidcLogins)
      .get()
    const idToken = `h.${b64url({ nonce: row!.nonce, exp: 9999999999 })}.s`

    const fetchMock = vi.fn()
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ access_token: 'at-1', id_token: idToken }),
    )
    fetchMock.mockResolvedValueOnce(jsonResponse({ email: 'user@example.com' }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/auth/oidc/callback?code=abc&state=${state}`,
    })
    expect(res.statusCode).toBe(302)
    expect(res.headers['set-cookie']).toMatch(/arrlink_auth_error=not_authorized/)
  })
})
