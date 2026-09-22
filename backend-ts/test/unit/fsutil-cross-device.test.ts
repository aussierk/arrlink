import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Regression test: sameDevice(src, dst) always stat'd `dst` itself, but a
// fresh dst never exists yet -- so it always returned null (never true/false)
// and no fallback branch in createLink ever engaged; every real cross-device
// link fell through to a raw, unhandled cross-device OS error. Fixed by
// stat-ing dst's *parent* directory instead, which does exist by the time
// createLink runs. A genuine cross-device mount isn't available in CI, so
// this fakes differing st_dev via a real statSync spy (not by injecting
// sameDevice itself, which would just re-assert the mock and miss the bug).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, statSync: vi.fn(actual.statSync) }
})

const { statSync } = await import('node:fs')
const { createLink, inodeOf } = await import('../../src/core/fsutil.js')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-fsutil-xdev-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.mocked(statSync).mockClear()
})

function fakeDeviceByDir(srcDir: string, dstDir: string) {
  const real = vi.mocked(statSync).getMockImplementation()!
  vi.mocked(statSync).mockImplementation((path, ...rest) => {
    const stats = real(path, ...rest) as Stats
    const p = String(path)
    stats.dev = p.startsWith(srcDir) ? 1 : p.startsWith(dstDir) ? 2 : stats.dev
    return stats
  })
}

describe('createLink: real cross-device fallback (no sameDevice injection)', () => {
  it('copy fallback engages once a fresh, not-yet-existing dst resolves via its parent dir', () => {
    const srcDir = join(dir, 'src_fs')
    const dstDir = join(dir, 'dst_fs')
    mkdirSync(srcDir)
    mkdirSync(dstDir)
    const src = join(srcDir, 'movie.mkv')
    const dst = join(dstDir, 'movie.mkv')
    writeFileSync(src, 'hello')

    fakeDeviceByDir(srcDir, dstDir)

    const r = createLink(src, dst, 'copy')
    expect(r.ok).toBe(true)
    expect(readFileSync(dst, 'utf-8')).toBe('hello')
    expect(inodeOf(src)).not.toBe(inodeOf(dst))
  })

  it('skip fallback refuses cleanly instead of throwing a raw cross-device error', () => {
    const srcDir = join(dir, 'src_fs')
    const dstDir = join(dir, 'dst_fs')
    mkdirSync(srcDir)
    mkdirSync(dstDir)
    const src = join(srcDir, 'movie.mkv')
    const dst = join(dstDir, 'movie.mkv')
    writeFileSync(src, 'hello')

    fakeDeviceByDir(srcDir, dstDir)

    const r = createLink(src, dst, 'skip')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/cross-filesystem/)
  })
})
