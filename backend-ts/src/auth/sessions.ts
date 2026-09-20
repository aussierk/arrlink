import { randomBytes } from 'node:crypto'
import { and, eq, isNotNull, lt, lte } from 'drizzle-orm'
import type { DbClient } from '../db/client.js'
import { logEvent } from '../db/events.js'
import { sessions } from '../db/schema.js'

export const REFRESH_TOKEN_COOKIE = 'arrlink_rt'
export const REFRESH_LEEWAY_S = 60
export const SWEEP_INTERVAL_S = 30

export type SessionKind = 'oidc' | 'password'

export interface Session {
  token: string
  email: string
  name: string | null
  groups: string[]
  refreshToken: string | null
  kind: SessionKind
  createdAt: number
  expiresAt: number
}

/** Matches Python's secrets.token_urlsafe(32): 32 random bytes, base64url, no padding. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Insert a session; returns (token, createdAt, expiresAt). */
export function createSession(
  db: DbClient,
  email: string,
  name: string | null,
  groups: string[],
  refreshToken: string | null,
  ttlH: number,
  kind: SessionKind = 'oidc',
): { token: string; createdAt: number; expiresAt: number } {
  const token = newSessionToken()
  const now = Date.now() / 1000
  const expiresAt = now + ttlH * 3600
  db.insert(sessions)
    .values({
      token,
      email,
      name,
      groupsJson: JSON.stringify(groups),
      refreshToken,
      kind,
      createdAt: now,
      expiresAt,
    })
    .run()
  return { token, createdAt: now, expiresAt }
}

export function getSession(db: DbClient, token: string): Session | null {
  const row = db.select().from(sessions).where(eq(sessions.token, token)).get()
  if (!row) return null
  return {
    token: row.token,
    email: row.email,
    name: row.name,
    groups: JSON.parse(row.groupsJson || '[]') as string[],
    refreshToken: row.refreshToken,
    kind: row.kind as SessionKind,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }
}

export function revokeSession(db: DbClient, token: string): void {
  db.delete(sessions).where(eq(sessions.token, token)).run()
}

interface OidcTokenClient {
  refreshTokens(refreshToken: string): Promise<{ refresh_token?: string }>
}

async function silentRefresh(
  db: DbClient,
  token: string,
  refreshToken: string | null,
  client: OidcTokenClient,
  ttlH: number,
): Promise<number | null> {
  let tok: { refresh_token?: string }
  try {
    tok = await client.refreshTokens(refreshToken ?? '')
  } catch {
    return null
  }
  const newRt = tok.refresh_token
  const expiresAt = Date.now() / 1000 + ttlH * 3600
  db.update(sessions)
    .set({ refreshToken: newRt || refreshToken, expiresAt })
    .where(eq(sessions.token, token))
    .run()
  return expiresAt
}

/** Sessions expiring within the leeway window (or already expired) that still hold a
 * provider refresh token. */
export function refreshDue(db: DbClient): Session[] {
  const cutoff = Date.now() / 1000 + REFRESH_LEEWAY_S
  const rows = db
    .select()
    .from(sessions)
    .where(and(isNotNull(sessions.refreshToken), lte(sessions.expiresAt, cutoff)))
    .all()
  return rows.map((row) => ({
    token: row.token,
    email: row.email,
    name: row.name,
    groups: JSON.parse(row.groupsJson || '[]') as string[],
    refreshToken: row.refreshToken,
    kind: row.kind as SessionKind,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }))
}

export interface SweepStats {
  refreshed: number
  failed: number
  purged: number
}

/**
 * One sweep pass: refresh due sessions, purge expired ones. Returns stats
 * for the events log / tests. `clientFactory` is only invoked lazily (on
 * the first due session) so a sweep with nothing to do never touches the
 * OIDC provider.
 */
export async function runSweep(
  db: DbClient,
  clientFactory: () => OidcTokenClient,
  ttlH: number,
): Promise<SweepStats> {
  const stats: SweepStats = { refreshed: 0, failed: 0, purged: 0 }
  let client: OidcTokenClient | null = null
  for (const s of refreshDue(db)) {
    try {
      client ??= clientFactory()
      const expires = await silentRefresh(db, s.token, s.refreshToken, client, ttlH)
      if (expires === null) {
        stats.failed += 1
        logEvent(db, 'warn', `session for ${s.email} dropped: OIDC refresh rejected`)
        revokeSession(db, s.token)
      } else {
        stats.refreshed += 1
      }
    } catch (e) {
      logEvent(db, 'error', `session refresh error: ${String(e)}`)
    }
  }
  const result = db
    .delete(sessions)
    .where(lt(sessions.expiresAt, Date.now() / 1000 - 1))
    .run()
  stats.purged = result.changes
  return stats
}
