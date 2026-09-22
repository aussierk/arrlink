import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Settings } from '../config/env.js'
import { effectiveAppUrl, effectiveAuth, type EffectiveAuth } from '../config/runtime.js'
import type { DbClient } from '../db/client.js'
import { logEvent } from '../db/events.js'
import { oidcLogins } from '../db/schema.js'
import type { SettingsStore } from '../db/settings-store.js'
import { HttpError } from '../http-error.js'
import * as lockout from '../auth/lockout.js'
import { OidcClient, OidcError, b64UrlEncode, decodeJwtPayload } from '../auth/oidc.js'
import { verifyPassword } from '../auth/passwords.js'
import * as sess from '../auth/sessions.js'
import { eq, lt } from 'drizzle-orm'

export const SESSION_COOKIE = 'arrlink_session'
export const PASSWORD_COOKIE = 'arrlink_pw'

// How long an initiated-but-never-completed OIDC login stays valid.
const OIDC_LOGIN_TTL_S = 600

// Error codes we ever set on arrlink_auth_error, plus what an IdP's `error`
// query param can legitimately be. Anything else is not trusted to reach
// the UI verbatim; see sanitizeErrorCode().
const KNOWN_AUTH_ERROR_CODES = new Set([
  'oidc_disabled',
  'missing_code',
  'not_authorized',
  'invalid_request',
  'unauthorized_client',
  'access_denied',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
  'interaction_required',
  'login_required',
  'account_selection_required',
  'consent_required',
])

export interface AuthRouteOptions {
  db: DbClient
  settingsStore: SettingsStore
  env: Settings
}

export interface CurrentUser {
  email: string | null
  name: string | null
  authenticated: true
  token?: string
}

function client(auth: EffectiveAuth): OidcClient {
  if (!(auth.oidcIssuer && auth.oidcClientId)) {
    throw new HttpError(503, 'OIDC not configured (issuer/client_id missing)')
  }
  return new OidcClient(auth.oidcIssuer, auth.oidcClientId, auth.oidcClientSecret || '')
}

const CALLBACK_PATH = '/auth/oidc/callback'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** The absolute redirect_uri handed to the OIDC provider. */
function redirectUri(
  request: FastifyRequest,
  db: DbClient,
  settingsStore: SettingsStore,
  env: Settings,
): string {
  const appUrl = effectiveAppUrl(settingsStore, env)
  if (appUrl) return `${appUrl.replace(/\/+$/, '')}${CALLBACK_PATH}`

  for (const raw of (env.trustedHosts ?? '').split(',')) {
    const host = raw.trim()
    if (host && !LOOPBACK_HOSTS.has(host) && !LOOPBACK_HOSTS.has(host.split(':')[0])) {
      return `https://${host}${CALLBACK_PATH}`
    }
  }

  logEvent(
    db,
    'warn',
    'OIDC redirect_uri not configured -- derived from the request Host ' +
      'header (spoofable unless a trusted reverse proxy is in front of ' +
      'this app). Set APP_URL or TRUSTED_HOSTS to pin it.',
  )
  const base = `${request.protocol}://${request.hostname}`
  return `${base}${CALLBACK_PATH}`
}

/** Only allow a same-origin relative path for the post-login redirect. */
function sanitizeNext(path: string | null | undefined): string {
  if (!path || path.includes('\\') || !path.startsWith('/')) return '/'
  try {
    const parsed = new URL(path, 'http://placeholder.invalid')
    if (parsed.origin !== 'http://placeholder.invalid') return '/'
  } catch {
    return '/'
  }
  return path
}

/** Never let an OIDC provider's raw `error` query param reach the UI verbatim. */
function sanitizeErrorCode(code: string | null | undefined): string {
  return code && KNOWN_AUTH_ERROR_CODES.has(code) ? code : 'server_error'
}

function secure(request: FastifyRequest): boolean {
  return request.protocol === 'https'
}

function setAuthCookies(
  reply: FastifyReply,
  request: FastifyRequest,
  sessionToken: string,
  refreshToken: string | null | undefined,
  maxAgeS: number,
): void {
  reply.setCookie(SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secure(request),
    maxAge: maxAgeS,
    path: '/',
  })
  if (refreshToken) {
    reply.setCookie(sess.REFRESH_TOKEN_COOKIE, refreshToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secure(request),
      maxAge: maxAgeS,
      path: '/',
    })
  }
}

function clearAuthCookies(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' })
  reply.clearCookie(sess.REFRESH_TOKEN_COOKIE, { path: '/' })
  reply.clearCookie(PASSWORD_COOKIE, { path: '/' })
}

/** Checks whichever credential cookie is present against its matching session
 * `kind` -- password and OIDC share the `sessions` table, so this confirms a
 * token came from the flow its cookie claims, not just that some token was found. */
function lookupSession(
  request: FastifyRequest,
  db: DbClient,
  auth: EffectiveAuth,
): sess.Session | null {
  const now = Date.now() / 1000
  if (auth.oidcEnabled) {
    const token = request.cookies[SESSION_COOKIE] ?? ''
    const s = token ? sess.getSession(db, token) : null
    if (s && s.kind === 'oidc' && s.expiresAt >= now) return s
  }
  if (auth.passwordEnabled) {
    const token = request.cookies[PASSWORD_COOKIE] ?? ''
    const s = token ? sess.getSession(db, token) : null
    if (s && s.kind === 'password' && s.expiresAt >= now) return s
  }
  return null
}

/** Allow-list (Settings, editable at runtime). Empty = anyone authenticated.
 * Allowed if email is in `oidc_allowed_emails` OR a group is in `oidc_allowed_groups`. */
function allowed(db: SettingsStore, email: string, groups: string[]): boolean {
  const rawEmails = db.getSetting<string[]>('oidc_allowed_emails') ?? []
  const rawGroups = db.getSetting<string[]>('oidc_allowed_groups') ?? []
  const emails = new Set(
    rawEmails.filter((e) => typeof e === 'string').map((e) => e.toLowerCase()),
  )
  const groupsAllowed = new Set(
    rawGroups.filter((g) => typeof g === 'string').map((g) => g.toLowerCase()),
  )
  if (emails.size === 0 && groupsAllowed.size === 0) return true
  if (email && emails.has(email.toLowerCase())) return true
  return groups.some((g) => typeof g === 'string' && groupsAllowed.has(g.toLowerCase()))
}

export function getCurrentUser(
  request: FastifyRequest,
  db: DbClient,
  settingsStore: SettingsStore,
  env: Settings,
): CurrentUser {
  const auth = effectiveAuth(settingsStore, env)
  if (!auth.passwordEnabled && !auth.oidcEnabled) {
    return { email: null, name: 'local', authenticated: true }
  }
  const s = lookupSession(request, db, auth)
  if (s === null) throw new HttpError(401, 'unauthenticated')
  return { email: s.email, name: s.name, authenticated: true, token: s.token }
}

const PasswordLoginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
})

export function registerAuthRoutes(app: FastifyInstance, opts: AuthRouteOptions): void {
  const { db, settingsStore, env } = opts

  // Never 401s -- the SPA uses this to decide whether to redirect to login.
  app.get('/api/auth/me', (request) => {
    const auth = effectiveAuth(settingsStore, env)
    const result: Record<string, unknown> = {
      authenticated: false,
      password_enabled: auth.passwordEnabled,
      oidc_enabled: auth.oidcEnabled,
      auto_login: auth.autoLogin,
      app_title: settingsStore.getSetting<string>('app_title') || 'ArrLink',
      display_timezone: settingsStore.getSetting<string>('display_timezone') || 'UTC',
    }
    if (!auth.passwordEnabled && !auth.oidcEnabled) {
      result.authenticated = true
      return result
    }
    const s = lookupSession(request, db, auth)
    if (s !== null) {
      result.authenticated = true
      result.email = s.email
      result.name = s.name
    }
    return result
  })

  app.post('/api/auth/password', async (request, reply) => {
    // Credentials arrive in the body, never the query string, so they
    // can't leak into access logs or browser history.
    const parsed = PasswordLoginSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    const body = parsed.data

    const auth = effectiveAuth(settingsStore, env)
    if (!auth.passwordEnabled) throw new HttpError(400, 'password login is not enabled')
    const expectedUsername = auth.uiUsername || 'admin'
    const expectedPassword = auth.uiPassword || ''
    if (!expectedPassword) {
      throw new HttpError(500, 'password login is misconfigured (no password set)')
    }
    const lockoutKey = expectedUsername.trim().toLowerCase()
    const st = lockout.status(db, lockoutKey)
    const usernameOk = constantTimeEqual(
      body.username.trim().toLowerCase(),
      expectedUsername.trim().toLowerCase(),
    )
    // Always run verifyPassword, even while locked -- skipping it would be
    // a timing side channel revealing lockout state.
    const passwordOk = await verifyPassword(body.password, expectedPassword)
    // Deliberately vague about which field was wrong (no username enumeration).
    if (st.locked || !(usernameOk && passwordOk)) {
      lockout.recordFailure(db, lockoutKey)
      throw new HttpError(401, 'wrong username or password')
    }
    lockout.reset(db, lockoutKey)
    const { token } = sess.createSession(
      db,
      expectedUsername,
      expectedUsername,
      [],
      null,
      auth.sessionTtlH,
      'password',
    )
    reply.setCookie(PASSWORD_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secure(request),
      maxAge: auth.sessionTtlH * 3600,
      path: '/',
    })
    return reply.redirect('/', 302)
  })

  // Escape hatch for an admin locked out of password login who still has a
  // valid session (e.g. via OIDC) -- clears the lockout immediately.
  app.post('/api/auth/password/unlock', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const auth = effectiveAuth(settingsStore, env)
    const lockoutKey = (auth.uiUsername || 'admin').trim().toLowerCase()
    lockout.reset(db, lockoutKey)
    logEvent(db, 'info', 'password lockout manually cleared')
    return { ok: true }
  })

  app.get('/api/auth/login', async (request, reply) => {
    const auth = effectiveAuth(settingsStore, env)
    if (!auth.oidcEnabled) throw new HttpError(400, 'OIDC login is not enabled')

    const query = request.query as { next?: string }
    const state = randomBytes(16).toString('base64url')
    const nonce = randomBytes(16).toString('base64url')
    const verifier = randomBytes(48).toString('base64url')
    const challenge = b64UrlEncode(createHash('sha256').update(verifier).digest())

    // Opportunistically sweep abandoned login attempts each time a new one starts.
    db.delete(oidcLogins)
      .where(lt(oidcLogins.createdAt, Date.now() / 1000 - OIDC_LOGIN_TTL_S))
      .run()
    db.insert(oidcLogins)
      .values({
        state,
        verifier,
        nonce,
        nextPath: sanitizeNext(query.next ?? '/'),
        createdAt: Date.now() / 1000,
      })
      .run()

    const oidcClient = client(auth)
    const d = await oidcClient.discovery()
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: oidcClient.clientId,
      redirect_uri: redirectUri(request, db, settingsStore, env),
      scope: 'openid profile email offline_access',
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    return reply.redirect(`${d.authorization_endpoint}?${params.toString()}`, 302)
  })

  app.get('/auth/oidc/callback', async (request, reply) => {
    const auth = effectiveAuth(settingsStore, env)
    const query = request.query as { code?: string; state?: string; error?: string }

    if (!auth.oidcEnabled) {
      // Defense in depth: an admin disabled OIDC mid-flight.
      logEvent(db, 'warn', 'OIDC callback received while OIDC login is disabled')
      reply.setCookie('arrlink_auth_error', 'oidc_disabled', { maxAge: 60, path: '/' })
      return reply.redirect('/', 302)
    }

    if (query.error || !query.code || !query.state) {
      logEvent(db, 'warn', `OIDC callback error: ${query.error || 'missing code/state'}`)
      reply.setCookie(
        'arrlink_auth_error',
        sanitizeErrorCode(query.error || 'missing_code'),
        {
          maxAge: 60,
          path: '/',
        },
      )
      return reply.redirect('/', 302)
    }

    const row = db
      .select()
      .from(oidcLogins)
      .where(eq(oidcLogins.state, query.state))
      .get()
    if (row) db.delete(oidcLogins).where(eq(oidcLogins.state, query.state)).run()
    if (!row || row.createdAt < Date.now() / 1000 - OIDC_LOGIN_TTL_S) {
      throw new HttpError(400, 'unknown or expired login state')
    }

    const oidcClient = client(auth)
    let tok: Record<string, unknown>
    try {
      tok = await oidcClient.exchangeCode(
        query.code,
        row.verifier,
        redirectUri(request, db, settingsStore, env),
      )
    } catch (e) {
      if (e instanceof OidcError) {
        logEvent(db, 'warn', `OIDC code exchange failed: ${e.detail}`)
        throw new HttpError(502, `OIDC exchange failed: ${e.detail}`)
      }
      throw e
    }

    // Validate nonce/exp from the id_token payload (no signature check, see auth/oidc.ts).
    const idToken = tok.id_token
    if (typeof idToken === 'string') {
      const payload = ((): ReturnType<typeof decodeJwtPayload> | null => {
        try {
          return decodeJwtPayload(idToken)
        } catch {
          return null
        }
      })()
      if (payload !== null) {
        if (payload.nonce !== row.nonce) {
          logEvent(db, 'warn', 'OIDC nonce mismatch -- possible replay')
          throw new HttpError(400, 'OIDC nonce mismatch')
        }
        if ((payload.exp ?? 0) < Date.now() / 1000) {
          logEvent(db, 'warn', 'OIDC id_token expired')
          throw new HttpError(400, 'OIDC id_token expired')
        }
      }
    }

    const accessToken = typeof tok.access_token === 'string' ? tok.access_token : ''
    if (!accessToken) throw new HttpError(502, 'OIDC token response missing access_token')

    let info: Record<string, unknown>
    try {
      info = await oidcClient.userinfo(accessToken)
    } catch (e) {
      if (e instanceof OidcError) {
        logEvent(db, 'warn', `OIDC userinfo failed: ${e.detail}`)
        throw new HttpError(502, `OIDC userinfo failed: ${e.detail}`)
      }
      throw e
    }

    const email = (typeof info.email === 'string' ? info.email : '').toLowerCase()
    if (!email) {
      logEvent(db, 'warn', 'OIDC userinfo missing email')
      throw new HttpError(400, 'OIDC identity has no email')
    }
    let groups: string[]
    if (typeof info.groups === 'string') {
      groups = info.groups
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean)
    } else if (Array.isArray(info.groups)) {
      groups = info.groups as string[]
    } else {
      groups = []
    }

    if (!allowed(settingsStore, email, groups)) {
      logEvent(
        db,
        'warn',
        `OIDC login rejected by allow-list: ${email} groups=${JSON.stringify(groups)}`,
      )
      reply.setCookie('arrlink_auth_error', 'not_authorized', { maxAge: 60, path: '/' })
      return reply.redirect('/', 302)
    }

    const refreshToken =
      typeof tok.refresh_token === 'string' ? tok.refresh_token : undefined
    const name = typeof info.name === 'string' ? info.name : null
    const { token, expiresAt } = sess.createSession(
      db,
      email,
      name,
      groups,
      refreshToken ?? null,
      auth.sessionTtlH,
      'oidc',
    )
    logEvent(db, 'info', `OIDC login: ${email}`)
    const nextPath = sanitizeNext(row.nextPath)
    setAuthCookies(
      reply,
      request,
      token,
      refreshToken,
      Math.round(expiresAt - Date.now() / 1000),
    )
    return reply.redirect(nextPath, 302)
  })

  app.post('/api/auth/logout', (request, reply) => {
    for (const cookieName of [SESSION_COOKIE, PASSWORD_COOKIE]) {
      const token = request.cookies[cookieName]
      if (token) sess.revokeSession(db, token)
    }
    clearAuthCookies(reply)
    return reply.redirect('/', 302)
  })
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
