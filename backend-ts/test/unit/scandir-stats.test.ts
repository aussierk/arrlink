import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scandirStats } from '../../src/arr/scandir-stats.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'arrlink-scandir-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('scandirStats', () => {
  it('returns stats only for the requested paths that exist, batched per directory', () => {
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    writeFileSync(a, 'hello')
    writeFileSync(b, 'world!')

    const stats = scandirStats([a, b, join(dir, 'missing.txt')])
    expect(stats.size).toBe(2)
    expect(stats.get(a)?.size).toBe(5)
    expect(stats.get(b)?.size).toBe(6)
    expect(stats.has(join(dir, 'missing.txt'))).toBe(false)
  })

  it('silently skips a directory that does not exist', () => {
    const stats = scandirStats([join(dir, 'nope', 'file.txt')])
    expect(stats.size).toBe(0)
  })

  it('handles paths spread across multiple directories', () => {
    const subA = join(dir, 'sub-a')
    const subB = join(dir, 'sub-b')
    mkdirSync(subA)
    mkdirSync(subB)
    writeFileSync(join(subA, 'f.txt'), '1')
    writeFileSync(join(subB, 'g.txt'), '22')

    const stats = scandirStats([join(subA, 'f.txt'), join(subB, 'g.txt')])
    expect(stats.get(join(subA, 'f.txt'))?.size).toBe(1)
    expect(stats.get(join(subB, 'g.txt'))?.size).toBe(2)
  })
})
