import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as sess from '../../src/auth/sessions.js'
import { closeDb, openDb, type DbClient } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'

let dir: string
let db: DbClient

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-sessions-'))
  db = openDb(join(dir, 'arrlink.db'))
  runMigrations(db)
})

afterEach(() => {
  closeDb(db)
  rmSync(dir, { recursive: true, force: true })
})

describe('createSession / getSession / revokeSession', () => {
  it('round-trips a session and computes expiry from the TTL', () => {
    const { token, createdAt, expiresAt } = sess.createSession(
      db,
      'a@example.com',
      'Alice',
      ['staff'],
      'rt-123',
      2,
      'oidc',
    )
    expect(expiresAt - createdAt).toBeCloseTo(2 * 3600, 0)

    const s = sess.getSession(db, token)
    expect(s).toMatchObject({
      token,
      email: 'a@example.com',
      name: 'Alice',
      groups: ['staff'],
      refreshToken: 'rt-123',
      kind: 'oidc',
    })
  })

  it('returns null for an unknown token', () => {
    expect(sess.getSession(db, 'nope')).toBeNull()
  })

  it('revokeSession deletes the row', () => {
    const { token } = sess.createSession(
      db,
      'a@example.com',
      null,
      [],
      null,
      1,
      'password',
    )
    sess.revokeSession(db, token)
    expect(sess.getSession(db, token)).toBeNull()
  })

  it('generates distinct unguessable tokens', () => {
    const a = sess.newSessionToken()
    const b = sess.newSessionToken()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(30)
  })
})

describe('refreshDue', () => {
  it('only includes sessions with a refresh token expiring within the leeway window', () => {
    const now = Date.now() / 1000
    // expires now + leeway - 1s: due
    const due = sess.createSession(db, 'due@example.com', null, [], 'rt-due', 0, 'oidc')
    // expires far in the future: not due
    sess.createSession(db, 'future@example.com', null, [], 'rt-future', 100, 'oidc')
    // expiring soon but no refresh token: not eligible
    sess.createSession(db, 'norefresh@example.com', null, [], null, 0, 'oidc')

    const list = sess.refreshDue(db)
    expect(list.map((s) => s.token)).toEqual([due.token])
    expect(now).toBeGreaterThan(0) // keep `now` referenced for clarity of intent above
  })
})

describe('runSweep', () => {
  it('refreshes a due session and updates its expiry/refresh token', async () => {
    const { token } = sess.createSession(
      db,
      'a@example.com',
      null,
      [],
      'rt-old',
      0,
      'oidc',
    )
    const stats = await sess.runSweep(
      db,
      () => ({
        refreshTokens: (rt: string) =>
          Promise.resolve({ refresh_token: `${rt}-rotated` }),
      }),
      5,
    )
    expect(stats).toEqual({ refreshed: 1, failed: 0, purged: 0 })
    const s = sess.getSession(db, token)
    expect(s?.refreshToken).toBe('rt-old-rotated')
    expect(s?.expiresAt).toBeGreaterThan(Date.now() / 1000 + 4 * 3600)
  })

  it('drops a session whose refresh fails and counts it', async () => {
    const { token } = sess.createSession(
      db,
      'a@example.com',
      null,
      [],
      'rt-old',
      0,
      'oidc',
    )
    const stats = await sess.runSweep(
      db,
      () => ({ refreshTokens: () => Promise.reject(new Error('provider rejected')) }),
      5,
    )
    expect(stats).toEqual({ refreshed: 0, failed: 1, purged: 0 })
    expect(sess.getSession(db, token)).toBeNull()
  })

  it('purges expired sessions regardless of refresh-token presence', async () => {
    // expiresAt already in the past, no refresh token -- not "due" (no
    // refresh token), but still purged as expired.
    sess.createSession(db, 'gone@example.com', null, [], null, -1, 'password')
    const stats = await sess.runSweep(
      db,
      () => ({ refreshTokens: () => Promise.resolve({}) }),
      1,
    )
    expect(stats.purged).toBe(1)
  })

  it('never calls the client factory when nothing is due', async () => {
    let called = false
    const stats = await sess.runSweep(
      db,
      () => {
        called = true
        return { refreshTokens: () => Promise.resolve({}) }
      },
      1,
    )
    expect(called).toBe(false)
    expect(stats).toEqual({ refreshed: 0, failed: 0, purged: 0 })
  })
})
