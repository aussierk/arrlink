import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import lockfile from 'proper-lockfile'

const LOCK_FILENAME = 'arrlink.lock'

// A lock older than this is treated as abandoned (crashed process) and may be
// stolen -- fcntl.flock's kernel auto-release has no exact Node equivalent,
// so this mtime-staleness check is the pragmatic replacement.
const STALE_MS = 30_000

export class InstanceLockError extends Error {}

interface HeldEntry {
  release: () => Promise<void>
  refcount: number
}

// resolved lock-file path -> (release fn, refcount). Multiple createApp()
// calls in one process (e.g. tests) share one OS-level lock.
const held = new Map<string, HeldEntry>()

function readHolderInfo(lockPath: string): string {
  try {
    const data = readFileSync(lockPath, 'utf-8').trim()
    return data || '(no diagnostics recorded)'
  } catch {
    return '(could not read lock file)'
  }
}

/** Acquire the instance lock for `dirPath`, returning the lock file path (pass
 * back to releaseInstanceLock). Throws InstanceLockError with the holder's
 * diagnostics if another live process already holds it. */
export async function acquireInstanceLock(dirPath: string): Promise<string> {
  mkdirSync(dirPath, { recursive: true })
  const lockPath = resolve(join(dirPath, LOCK_FILENAME))

  const existing = held.get(lockPath)
  if (existing) {
    existing.refcount += 1
    return lockPath
  }

  if (!existsSync(lockPath)) writeFileSync(lockPath, '')

  let release: () => Promise<void>
  try {
    release = await lockfile.lock(lockPath, { stale: STALE_MS, retries: 0 })
  } catch {
    const holder = readHolderInfo(lockPath)
    throw new InstanceLockError(
      `another arrlink instance already holds the lock at ${lockPath} ` +
        `(recorded holder: ${holder}). Stop the other instance, or if ` +
        `you're certain it's dead and your filesystem doesn't honor ` +
        `advisory locks, remove ${lockPath} and restart.`,
    )
  }

  writeFileSync(
    lockPath,
    JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      startedAt: Date.now() / 1000,
    }),
  )
  held.set(lockPath, { release, refcount: 1 })
  return lockPath
}

export async function releaseInstanceLock(lockPath: string): Promise<void> {
  const entry = held.get(lockPath)
  if (!entry) return
  entry.refcount -= 1
  if (entry.refcount > 0) return
  held.delete(lockPath)
  try {
    await entry.release()
  } catch {
    // already released/unlocked -- nothing to do
  }
}
