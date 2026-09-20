import { mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  InstanceLockError,
  acquireInstanceLock,
  releaseInstanceLock,
} from '../../src/singleton.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-singleton-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('acquireInstanceLock / releaseInstanceLock', () => {
  it('refcounts repeated acquires in the same process instead of re-locking', async () => {
    const first = await acquireInstanceLock(dir)
    const second = await acquireInstanceLock(dir)
    expect(second).toBe(first)

    // one release each -- the lock should still be held after the first
    await releaseInstanceLock(first)
    // a fresh external acquire attempt should still conflict (refcount 1 left)
    await expect(lockfile.lock(first, { stale: 30_000, retries: 0 })).rejects.toThrow()

    await releaseInstanceLock(second)
    // now fully released -- an external lock attempt should succeed
    const release = await lockfile.lock(first, { stale: 30_000, retries: 0 })
    await release()
  })

  it('rejects with InstanceLockError, including holder diagnostics, when already locked externally', async () => {
    const lockPath = join(dir, 'arrlink.lock')
    const release = await lockfile.lock(lockPath, {
      realpath: false,
      stale: 30_000,
      retries: 0,
    })

    await expect(acquireInstanceLock(dir)).rejects.toThrow(InstanceLockError)
    await expect(acquireInstanceLock(dir)).rejects.toThrow(/already holds the lock/)

    await release()
  })

  it('lets a stale lock (crashed process) be recovered', async () => {
    const lockPath = join(dir, 'arrlink.lock')
    await lockfile.lock(lockPath, { realpath: false, stale: 30_000, retries: 0 })

    // Simulate a process that died without releasing: proper-lockfile
    // treats a lock as stale once its lock-dir's mtime exceeds `stale` --
    // back-date it instead of waiting out the real interval.
    const lockDir = `${lockPath}.lock`
    const past = new Date(Date.now() - 60_000)
    utimesSync(lockDir, past, past)
    expect(statSync(lockDir).mtime.getTime()).toBeLessThan(Date.now() - 30_000)

    const acquired = await acquireInstanceLock(dir)
    expect(acquired).toBe(lockPath)
    await releaseInstanceLock(acquired)
  })
})
