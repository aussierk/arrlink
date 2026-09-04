import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useSort } from './useSort'

type Row = { name: string; n: number; when: number | null }

const rows: Row[] = [
  { name: 'beta', n: 2, when: 100 },
  { name: 'alpha', n: 10, when: null },
  { name: 'gamma', n: 1, when: 50 },
]

const acc = {
  name: (r: Row) => r.name,
  n: (r: Row) => r.n,
  when: (r: Row) => r.when,
}

describe('useSort', () => {
  it('sorts by the initial key ascending', () => {
    const { result } = renderHook(() => useSort(rows, acc, 'name'))
    expect(result.current.sorted.map((r) => r.name)).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('compares numbers numerically, not lexically', () => {
    const { result } = renderHook(() => useSort(rows, acc, 'n'))
    expect(result.current.sorted.map((r) => r.n)).toEqual([1, 2, 10])
  })

  it('toggles direction when the same key is clicked again', () => {
    const { result } = renderHook(() => useSort(rows, acc, 'name'))
    act(() => result.current.toggleSort('name'))
    expect(result.current.sortDir).toBe('desc')
    expect(result.current.sorted.map((r) => r.name)).toEqual(['gamma', 'beta', 'alpha'])
  })

  it('keeps nulls last regardless of direction', () => {
    const { result } = renderHook(() => useSort(rows, acc, 'when'))
    expect(result.current.sorted.map((r) => r.when)).toEqual([50, 100, null])
    act(() => result.current.toggleSort('when'))
    expect(result.current.sorted.map((r) => r.when)).toEqual([100, 50, null])
  })

  it('switching key resets direction to ascending', () => {
    const { result } = renderHook(() => useSort(rows, acc, 'name'))
    act(() => result.current.toggleSort('name')) // -> desc
    act(() => result.current.toggleSort('n')) // new key -> asc
    expect(result.current.sortKey).toBe('n')
    expect(result.current.sortDir).toBe('asc')
  })
})

describe('useSort tiebreaker + reset', () => {
  type Prioritized = { name: string; priority: number }
  const tied: Prioritized[] = [
    { name: 'dup', priority: 3 },
    { name: 'dup', priority: 1 },
    { name: 'solo', priority: 2 },
    { name: 'dup', priority: 2 },
  ]
  const tiedAcc = { name: (r: Prioritized) => r.name }

  it('breaks ties on the primary column using the tiebreaker, ascending', () => {
    const { result } = renderHook(() =>
      useSort(tied, tiedAcc, 'name', 'asc', (r: Prioritized) => r.priority),
    )
    expect(result.current.sorted.map((r) => r.priority)).toEqual([1, 2, 3, 2])
  })

  it('tiebreaker stays ascending even when the primary direction is desc', () => {
    const { result } = renderHook(() =>
      useSort(tied, tiedAcc, 'name', 'asc', (r: Prioritized) => r.priority),
    )
    act(() => result.current.toggleSort('name')) // -> desc
    // 'solo' now comes first (desc), then the three 'dup' rows still
    // ascending by priority among themselves.
    expect(result.current.sorted.map((r) => r.name)).toEqual([
      'solo',
      'dup',
      'dup',
      'dup',
    ])
    expect(
      result.current.sorted.filter((r) => r.name === 'dup').map((r) => r.priority),
    ).toEqual([1, 2, 3])
  })

  it('reset() restores the initial key/dir and isDefault reflects it', () => {
    const { result } = renderHook(() => useSort(rows, acc, 'name', 'asc'))
    expect(result.current.isDefault).toBe(true)
    act(() => result.current.toggleSort('n'))
    expect(result.current.isDefault).toBe(false)
    act(() => result.current.reset())
    expect(result.current.sortKey).toBe('name')
    expect(result.current.sortDir).toBe('asc')
    expect(result.current.isDefault).toBe(true)
  })
})
