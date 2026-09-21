import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLink, inodeOf, removeLink, sameDevice } from '../../src/core/fsutil.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-fsutil-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createLink: happy path', () => {
  it('hardlinks a regular file', () => {
    const src = join(dir, 'src.txt')
    const dst = join(dir, 'dst.txt')
    writeFileSync(src, 'hello')

    const r = createLink(src, dst, 'skip')
    expect(r.ok).toBe(true)
    expect(inodeOf(src)).toBe(inodeOf(dst))
  })

  it('is idempotent when the destination is already the same hardlink', () => {
    const src = join(dir, 'src.txt')
    const dst = join(dir, 'dst.txt')
    writeFileSync(src, 'hello')
    createLink(src, dst, 'skip')

    const r = createLink(src, dst, 'skip')
    expect(r.ok).toBe(true)
  })

  it('replaces a stray symlink found at the destination', () => {
    const src = join(dir, 'src.txt')
    const dst = join(dir, 'dst.txt')
    const decoy = join(dir, 'decoy.txt')
    writeFileSync(src, 'hello')
    writeFileSync(decoy, 'decoy')
    symlinkSync(decoy, dst)

    const r = createLink(src, dst, 'skip')
    expect(r.ok).toBe(true)
    expect(inodeOf(src)).toBe(inodeOf(dst))
  })
})

describe('createLink: defense in depth', () => {
  it('refuses a symlink source', () => {
    const real = join(dir, 'real.txt')
    const src = join(dir, 'src.txt')
    const dst = join(dir, 'dst.txt')
    writeFileSync(real, 'x')
    symlinkSync(real, src)

    const r = createLink(src, dst, 'skip')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/symlink/)
    expect(existsSync(dst)).toBe(false)
  })

  it('refuses a name collision with a different inode and leaves the foreign file untouched', () => {
    const src = join(dir, 'src.txt')
    const dst = join(dir, 'dst.txt')
    writeFileSync(src, 'hello')
    writeFileSync(dst, "someone else's file")

    const r = createLink(src, dst, 'skip')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/collision/)
    expect(readFileSync(dst, 'utf-8')).toBe("someone else's file")
  })

  // Regression test mirroring tests/test_fsutil.py's TOCTOU test: even when
  // the early islink()/isfile() checks are bypassed (simulating a race
  // between the check and the link), the O_NOFOLLOW-guarded open must
  // still refuse a symlink source. Only meaningful on POSIX, where
  // O_NOFOLLOW exists -- see fsutil.ts's comment on why it's a no-op gap
  // on Windows dev machines, not a production one.
  it.skipIf(process.platform === 'win32')(
    'refuses a symlink source even if the early check is bypassed (TOCTOU hardening)',
    () => {
      const secret = join(dir, 'secret.txt')
      const src = join(dir, 'movie.mkv')
      const linkedDir = join(dir, 'linked')
      const dst = join(linkedDir, 'movie.mkv')
      writeFileSync(secret, 'do not link me')
      symlinkSync(secret, src)
      mkdirSync(linkedDir)

      const r = createLink(src, dst, 'skip', {
        isSymlink: () => false,
        isFile: () => true,
      })
      expect(r.ok).toBe(false)
      expect(existsSync(dst)).toBe(false)
    },
  )
})

describe('createLink: cross-device fallback', () => {
  // A genuine cross-device mount isn't available in this dev/CI
  // environment, so `sameDevice` is injected the same way Python's test
  // suite monkeypatches `same_device` -- see the plan's cross-device risk
  // callout for why this only proves the fallback logic, not real
  // cross-filesystem hardlink behavior.
  it('skip: refuses without touching the destination', () => {
    const src = join(dir, 'src.txt')
    const dst = join(dir, 'dst.txt')
    writeFileSync(src, 'hello')

    const r = createLink(src, dst, 'skip', { sameDevice: () => false })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/cross-filesystem/)
    expect(existsSync(dst)).toBe(false)
  })

  it('symlink: creates a symlink instead of a hardlink', () => {
    const src = join(dir, 'src.txt')
    const dst = join(dir, 'dst.txt')
    writeFileSync(src, 'hello')

    const r = createLink(src, dst, 'symlink', { sameDevice: () => false })
    expect(r.ok).toBe(true)
    expect(statSync(dst).isFile()).toBe(true) // follows the symlink
    expect(readFileSync(dst, 'utf-8')).toBe('hello')
  })

  it('copy: duplicates content into a distinct inode', () => {
    const src = join(dir, 'src.txt')
    const dst = join(dir, 'dst.txt')
    writeFileSync(src, 'hello')

    const r = createLink(src, dst, 'copy', { sameDevice: () => false })
    expect(r.ok).toBe(true)
    expect(readFileSync(dst, 'utf-8')).toBe('hello')
    expect(inodeOf(src)).not.toBe(inodeOf(dst))
  })

  it('copy: preserves mode and mtime from the source', () => {
    const src = join(dir, 'src.txt')
    const dst = join(dir, 'dst.txt')
    writeFileSync(src, 'hello')
    const srcStat = statSync(src)

    createLink(src, dst, 'copy', { sameDevice: () => false })
    const dstStat = statSync(dst)
    expect(dstStat.mode).toBe(srcStat.mode)
    expect(Math.round(dstStat.mtimeMs / 1000)).toBe(Math.round(srcStat.mtimeMs / 1000))
  })
})

describe('removeLink', () => {
  it('refuses to remove a symlink', () => {
    const target = join(dir, 'target.txt')
    const link = join(dir, 'link.txt')
    writeFileSync(target, 'x')
    symlinkSync(target, link)

    const r = removeLink(link, [dir])
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/symlink/)
    expect(existsSync(link)).toBe(true)
  })

  it('treats an already-gone path as success', () => {
    const r = removeLink(join(dir, 'nonexistent.txt'), [dir])
    expect(r.ok).toBe(true)
  })

  it('removes a real file (the dir entry only -- content survives via other links)', () => {
    const src = join(dir, 'src.txt')
    const dst = join(dir, 'dst.txt')
    writeFileSync(src, 'hello')
    createLink(src, dst, 'skip')

    const r = removeLink(dst, [dir])
    expect(r.ok).toBe(true)
    expect(existsSync(dst)).toBe(false)
    expect(existsSync(src)).toBe(true)
    expect(readFileSync(src, 'utf-8')).toBe('hello')
  })

  it('prunes now-empty parent directories up to (not including) an allowed root', () => {
    const src = join(dir, 'src.txt')
    const nested = join(dir, 'movies', 'English', 'Some Title (2005)')
    const dst = join(nested, 'dst.txt')
    writeFileSync(src, 'hello')
    mkdirSync(nested, { recursive: true })
    createLink(src, dst, 'skip')

    const r = removeLink(dst, [dir])
    expect(r.ok).toBe(true)
    expect(existsSync(nested)).toBe(false)
    expect(existsSync(join(dir, 'movies', 'English'))).toBe(false)
    expect(existsSync(join(dir, 'movies'))).toBe(false)
    expect(existsSync(dir)).toBe(true) // the root itself is never removed
  })

  it('stops pruning at the first non-empty ancestor', () => {
    const src1 = join(dir, 'src1.txt')
    const src2 = join(dir, 'movies', 'keep-me.txt')
    const nested = join(dir, 'movies', 'English')
    const dst = join(nested, 'dst.txt')
    writeFileSync(src1, 'hello')
    mkdirSync(nested, { recursive: true })
    writeFileSync(src2, 'unrelated file that should survive')
    createLink(src1, dst, 'skip')

    const r = removeLink(dst, [dir])
    expect(r.ok).toBe(true)
    expect(existsSync(nested)).toBe(false) // now-empty, pruned
    expect(existsSync(join(dir, 'movies'))).toBe(true) // still has keep-me.txt
    expect(existsSync(src2)).toBe(true)
  })

  it('never removes a configured root, even when it is empty', () => {
    const emptyRoot = join(dir, 'linked')
    mkdirSync(emptyRoot)
    const src = join(dir, 'src.txt')
    const dst = join(emptyRoot, 'dst.txt')
    writeFileSync(src, 'hello')
    createLink(src, dst, 'skip')

    const r = removeLink(dst, [emptyRoot])
    expect(r.ok).toBe(true)
    expect(existsSync(emptyRoot)).toBe(true)
  })
})

describe('sameDevice', () => {
  it('returns true for two paths on the same filesystem', () => {
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    writeFileSync(a, '1')
    writeFileSync(b, '2')
    expect(sameDevice(a, b)).toBe(true)
  })

  it('returns null when a path does not exist', () => {
    expect(sameDevice(join(dir, 'a.txt'), join(dir, 'nope.txt'))).toBeNull()
  })
})
