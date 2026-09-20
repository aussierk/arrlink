import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as lockout from '../../src/auth/lockout.js'
import { closeDb, openDb, type DbClient } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'

let dir: string
let db: DbClient

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-lockout-'))
  db = openDb(join(dir, 'arrlink.db'))
  runMigrations(db)
})

afterEach(() => {
  closeDb(db)
  rmSync(dir, { recursive: true, force: true })
})

describe('lockout', () => {
  it('reports unlocked with zero failures for an unknown username', () => {
    expect(lockout.status(db, 'admin')).toEqual({
      locked: false,
      lockedUntil: null,
      failCount: 0,
    })
  })

  it('does not lock before the threshold', () => {
    for (let i = 0; i < lockout.THRESHOLD - 1; i++) {
      const r = lockout.recordFailure(db, 'admin')
      expect(r.locked).toBe(false)
    }
    expect(lockout.status(db, 'admin').failCount).toBe(lockout.THRESHOLD - 1)
  })

  it('locks after THRESHOLD failures within the window', () => {
    let last: lockout.LockoutStatus | undefined
    for (let i = 0; i < lockout.THRESHOLD; i++) {
      last = lockout.recordFailure(db, 'admin')
    }
    expect(last!.locked).toBe(true)
    expect(last!.lockedUntil).toBeGreaterThan(Date.now() / 1000)
    expect(lockout.status(db, 'admin').locked).toBe(true)
  })

  it('keeps reporting locked (without re-extending) on further failures while locked', () => {
    for (let i = 0; i < lockout.THRESHOLD; i++) lockout.recordFailure(db, 'admin')
    const first = lockout.status(db, 'admin')
    const again = lockout.recordFailure(db, 'admin')
    expect(again.locked).toBe(true)
    expect(again.lockedUntil).toBe(first.lockedUntil)
  })

  it('reset clears both the failure count and the lock', () => {
    for (let i = 0; i < lockout.THRESHOLD; i++) lockout.recordFailure(db, 'admin')
    lockout.reset(db, 'admin')
    expect(lockout.status(db, 'admin')).toEqual({
      locked: false,
      lockedUntil: null,
      failCount: 0,
    })
  })

  it('tracks separate usernames independently', () => {
    lockout.recordFailure(db, 'admin')
    lockout.recordFailure(db, 'other')
    lockout.recordFailure(db, 'other')
    expect(lockout.status(db, 'admin').failCount).toBe(1)
    expect(lockout.status(db, 'other').failCount).toBe(2)
  })
})
