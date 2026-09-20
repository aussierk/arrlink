import { describe, expect, it } from 'vitest'
import { pruneSelection } from './pruneSelection'

describe('pruneSelection', () => {
  it('drops ids that are no longer visible', () => {
    const selected = new Set([1, 2, 3])
    const result = pruneSelection(selected, new Set([1, 3]))
    expect(result).toEqual(new Set([1, 3]))
  })

  it('returns the same reference when nothing needs dropping', () => {
    const selected = new Set([1, 2])
    const result = pruneSelection(selected, new Set([1, 2, 3]))
    expect(result).toBe(selected)
  })

  it('drops everything when nothing selected is visible', () => {
    const selected = new Set([1, 2])
    const result = pruneSelection(selected, new Set([9]))
    expect(result).toEqual(new Set())
  })

  it('is a no-op on an empty selection', () => {
    const selected = new Set<number>()
    const result = pruneSelection(selected, new Set([1, 2]))
    expect(result).toBe(selected)
  })
})
