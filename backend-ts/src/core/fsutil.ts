import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeSync,
  type Stats,
} from 'node:fs'
import type { SettingsStore } from '../db/settings-store.js'
import { normalizeFsFallback, type FsFallbackMode } from '../config/env.js'

/**
 * Filesystem primitives for the hardlinker. Ported from core/fsutil.py.
 *
 * All operations are defensive: we only ever create/remove entries that we
 * created ourselves (tracked in the `links` table), and we verify inodes
 * before deleting anything. The O_NOFOLLOW-guarded open + post-hoc inode
 * verification in createLink is a deliberate TOCTOU defense against a
 * source path being swapped for a symlink between the early islink() check
 * and the actual link() -- port every check here in the same order, and
 * don't "simplify" any of them away (see the plan's fsutil risk callout).
 */

export interface LinkResult {
  ok: boolean
  dst: string
  error: string | null
}

function ok(dst: string): LinkResult {
  return { ok: true, dst, error: null }
}

function fail(dst: string, error: string): LinkResult {
  return { ok: false, dst, error }
}

export function ensureDir(dirPath: string): boolean {
  try {
    mkdirSync(dirPath, { recursive: true })
    return true
  } catch {
    return false
  }
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch {
    return null
  }
}

function statOrNull(path: string): Stats | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

function isSymlink(path: string): boolean {
  return lstatOrNull(path)?.isSymbolicLink() ?? false
}

function isFile(path: string): boolean {
  return statOrNull(path)?.isFile() ?? false
}

function lexists(path: string): boolean {
  return lstatOrNull(path) !== null
}

export function inodeOf(path: string): number | null {
  return statOrNull(path)?.ino ?? null
}

/** true/false if both paths exist and are on the same device, else null. */
export function sameDevice(a: string, b: string): boolean | null {
  const sa = statOrNull(a)
  const sb = statOrNull(b)
  if (sa === null || sb === null) return null
  return sa.dev === sb.dev
}

function errorDetail(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return String(e)
}

const COPY_CHUNK_BYTES = 1024 * 1024

/**
 * Copies from an already-open fd (the O_NOFOLLOW-verified source) to a
 * fresh file at `dst`, never reopening `src` by path -- reopening here
 * would reintroduce the TOCTOU window the fd-based open above exists to
 * close.
 */
function copyFromFd(srcFd: number, dst: string): void {
  const dstFd = openSync(dst, 'w')
  try {
    const buf = Buffer.alloc(COPY_CHUNK_BYTES)
    let position = 0
    for (;;) {
      const bytesRead = readSync(srcFd, buf, 0, buf.length, position)
      if (bytesRead === 0) break
      writeSync(dstFd, buf, 0, bytesRead)
      position += bytesRead
    }
  } finally {
    closeSync(dstFd)
  }
}

export interface CreateLinkDeps {
  /** Override point for tests -- exercising the cross-device fallback branches needs a
   * genuine cross-device mount otherwise (same limitation the Python test suite has, where
   * it monkeypatches same_device for exactly this reason). Defaults to the real sameDevice. */
  sameDevice?: (a: string, b: string) => boolean | null
  /** Override point for the TOCTOU regression test: simulates the early islink/isfile checks
   * being bypassed (e.g. a race), so the test can confirm the O_NOFOLLOW-guarded open below is
   * a real, independent defense and not the only thing standing between a symlink source and a
   * created link. Defaults to the real checks. */
  isSymlink?: (path: string) => boolean
  isFile?: (path: string) => boolean
}

/** Hardlink src -> dst, with the configured fallback on cross-device. */
export function createLink(
  src: string,
  dst: string,
  fallback: FsFallbackMode = 'skip',
  deps: CreateLinkDeps = {},
): LinkResult {
  const sameDeviceFn = deps.sameDevice ?? sameDevice
  const isSymlinkFn = deps.isSymlink ?? isSymlink
  const isFileFn = deps.isFile ?? isFile

  if (isSymlinkFn(src)) return fail(dst, 'source is a symlink (refused)')
  if (!isFileFn(src)) return fail(dst, 'source missing')

  if (lexists(dst)) {
    if (isSymlinkFn(dst)) {
      // a stray symlink where we expect our own link -> replace
      try {
        unlinkSync(dst)
      } catch {
        // best effort -- fall through and let the subsequent link attempt surface any real error
      }
    } else {
      const same = inodeOf(dst) === inodeOf(src)
      if (same) return ok(dst) // already linked
      return fail(dst, 'name collision (different inode)')
    }
  }

  const dev = sameDeviceFn(src, dst)
  if (dev === false && fallback === 'skip') {
    return fail(dst, 'cross-filesystem (hardlink impossible)')
  }

  if (dev === false && fallback === 'symlink') {
    try {
      symlinkSync(src, dst)
      return ok(dst)
    } catch (e) {
      return fail(dst, errorDetail(e))
    }
  }

  let fd: number
  try {
    // O_NOFOLLOW is the TOCTOU guard: if `src` was swapped for a symlink
    // after the islink() check above, this open fails closed instead of
    // silently following it. Only defined on POSIX -- production is
    // Linux-only (see the Dockerfile), so this is always present there;
    // it's simply absent on a Windows dev machine, where this function
    // falls back to a plain open (dev-only gap, not a production one).
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    fd = openSync(src, flags)
  } catch (e) {
    return fail(dst, `source changed before linking: ${errorDetail(e)}`)
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) {
      return fail(dst, 'source changed before linking (not a regular file)')
    }

    if (dev === false && fallback === 'copy') {
      try {
        copyFromFd(fd, dst)
        chmodSync(dst, st.mode)
        utimesSync(dst, st.atime, st.mtime)
      } catch (e) {
        return fail(dst, errorDetail(e))
      }
      return ok(dst)
    }

    try {
      linkSync(src, dst)
    } catch (e) {
      return fail(dst, errorDetail(e))
    }

    const dlst = lstatSync(dst)
    if (!dlst.isFile() || dlst.ino !== st.ino || dlst.dev !== st.dev) {
      try {
        unlinkSync(dst)
      } catch {
        // best effort cleanup
      }
      return fail(dst, 'source changed during linking (aborted)')
    }
    return ok(dst)
  } finally {
    closeSync(fd)
  }
}

/**
 * The effective cross-filesystem fallback mode. A runtime value set via
 * the `fs_fallback` Setting (Settings page) takes precedence over the
 * process/env default; both are normalized to a valid mode.
 */
export function resolveFsFallback(
  db: SettingsStore | null,
  envDefault: FsFallbackMode = 'skip',
): FsFallbackMode {
  const value = db?.getSetting<string>('fs_fallback')
  return normalizeFsFallback(value, envDefault)
}

/**
 * Remove a link we created. Refuses symlinks; removes the dir entry only
 * (the file data survives via its other links / the source).
 */
export function removeLink(dst: string): LinkResult {
  if (isSymlink(dst)) return fail(dst, 'refusing to remove a symlink')
  if (!lexists(dst)) return ok(dst) // already gone
  try {
    unlinkSync(dst)
    return ok(dst)
  } catch (e) {
    return fail(dst, errorDetail(e))
  }
}
