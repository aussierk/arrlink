import { eq } from 'drizzle-orm'
import type { DbClient } from '../db/client.js'
import { logEvent } from '../db/events.js'
import { loginAttempts } from '../db/schema.js'

// Flat lockout, not exponential backoff -- 5 failures within a 15-minute
// window locks the account for 15 minutes. Hardcoded, not
// Settings-editable. POST /api/auth/password.
export const THRESHOLD = 5
export const WINDOW_S = 15 * 60
export const LOCKOUT_S = 15 * 60

export interface LockoutStatus {
  locked: boolean
  lockedUntil: number | null
  failCount: number
}

// Accepts either the top-level DbClient or the `tx` handle a
// db.transaction() callback receives -- both expose the same query-builder
// surface this module needs, but drizzle types them differently ($client
// only exists on the top-level client).
type Queryable = Pick<DbClient, 'select' | 'insert' | 'delete'>

function row(db: Queryable, username: string) {
  return db.select().from(loginAttempts).where(eq(loginAttempts.username, username)).get()
}

export function status(db: DbClient, username: string): LockoutStatus {
  const r = row(db, username)
  if (!r) return { locked: false, lockedUntil: null, failCount: 0 }
  const now = Date.now() / 1000
  const locked = Boolean(r.lockedUntil && r.lockedUntil > now)
  return { locked, lockedUntil: locked ? r.lockedUntil : null, failCount: r.failCount }
}

/**
 * Record one failed attempt, atomically. better-sqlite3 is synchronous and
 * single-connection-per-process (unlike Python's thread-per-connection
 * sqlite3), so a plain db.transaction() wrapper gives the same atomicity
 * the original's explicit `BEGIN IMMEDIATE` provided -- see the plan's
 * "Background jobs" section for why this simplification is safe as long as
 * no DB writes ever move to a worker thread.
 */
export function recordFailure(db: DbClient, username: string): LockoutStatus {
  const result = db.transaction((tx) => {
    const now = Date.now() / 1000
    const r = row(tx, username)
    const wasLocked = Boolean(r?.lockedUntil && r.lockedUntil > now)

    if (wasLocked) {
      return {
        locked: true,
        lockedUntil: r!.lockedUntil,
        failCount: r!.failCount,
        justLocked: false,
      }
    }

    let failCount: number
    let firstFailAt: number
    if (!r || !r.firstFailAt || now - r.firstFailAt > WINDOW_S) {
      failCount = 1
      firstFailAt = now
    } else {
      failCount = r.failCount + 1
      firstFailAt = r.firstFailAt
    }

    const lockedUntil = failCount >= THRESHOLD ? now + LOCKOUT_S : null

    tx.insert(loginAttempts)
      .values({ username, failCount, firstFailAt, lastFailAt: now, lockedUntil })
      .onConflictDoUpdate({
        target: loginAttempts.username,
        set: { failCount, firstFailAt, lastFailAt: now, lockedUntil },
      })
      .run()

    return {
      locked: lockedUntil !== null,
      lockedUntil,
      failCount,
      justLocked: lockedUntil !== null,
    }
  })

  if (result.justLocked) {
    // was_locked is already known false here, so any lockedUntil we just
    // set is a fresh transition -- log once, not on every subsequent
    // attempt during the lockout.
    logEvent(
      db,
      'warn',
      `password login locked for ${(LOCKOUT_S / 60).toFixed(0)} min after ` +
        `${result.failCount} failed attempts (username=${JSON.stringify(username)})`,
    )
  }

  return {
    locked: result.locked,
    lockedUntil: result.lockedUntil,
    failCount: result.failCount,
  }
}

export function reset(db: DbClient, username: string): void {
  db.delete(loginAttempts).where(eq(loginAttempts.username, username)).run()
}
