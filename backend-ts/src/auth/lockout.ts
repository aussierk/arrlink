import { eq } from 'drizzle-orm'
import type { DbClient } from '../db/client.js'
import { logEvent } from '../db/events.js'
import { loginAttempts } from '../db/schema.js'

// Flat lockout: 5 failures within 15 minutes locks the account for 15
// minutes. Hardcoded, not Settings-editable.
export const THRESHOLD = 5
export const WINDOW_S = 15 * 60
export const LOCKOUT_S = 15 * 60

export interface LockoutStatus {
  locked: boolean
  lockedUntil: number | null
  failCount: number
}

// Accepts either the top-level DbClient or a transaction's `tx` handle --
// drizzle types them differently, but both expose what this module needs.
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

/** Record one failed attempt, atomically. better-sqlite3 is single-connection
 * and synchronous, so a plain db.transaction() gives the same atomicity
 * Python's explicit BEGIN IMMEDIATE provided. */
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
    // Fresh transition (wasLocked was false) -- log once, not every attempt.
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
