import { useMemo, useState } from 'react'

export type SortDir = 'asc' | 'desc'

type Accessor<T> = (row: T) => string | number | null | undefined

/**
 * Client-side column sorting for a table. `accessors` maps a column key to a
 * value getter; pass it as a module-level constant so it stays referentially
 * stable across renders. Nulls always sort last regardless of direction;
 * strings compare with locale + numeric awareness ("q2" before "q10").
 *
 * `tiebreaker`, if given, breaks ties on the primary column (ascending,
 * independent of `dir`) — e.g. always falling back to priority order so a
 * sort-by-name never scrambles same-named rows arbitrarily. `reset()`
 * restores `initialKey`/`initialDir`, for a "back to default order" control
 * when the tiebreaker column itself has no visible header to click.
 */
export function useSort<T>(
  rows: T[],
  accessors: Record<string, Accessor<T>>,
  initialKey: string,
  initialDir: SortDir = 'asc',
  tiebreaker?: Accessor<T>,
) {
  const [key, setKey] = useState(initialKey)
  const [dir, setDir] = useState<SortDir>(initialDir)

  const sorted = useMemo(() => {
    const get = accessors[key]
    if (!get) return rows
    const factor = dir === 'asc' ? 1 : -1
    // Nulls always sort last, independent of `factor` -- only the non-null
    // comparison itself flips with direction.
    const cmp = (
      av: ReturnType<Accessor<T>>,
      bv: ReturnType<Accessor<T>>,
      f: number,
    ): number => {
      const aNull = av == null || av === ''
      const bNull = bv == null || bv === ''
      if (aNull && bNull) return 0
      if (aNull) return 1
      if (bNull) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * f
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * f
    }
    return [...rows].sort((a, b) => {
      const primary = cmp(get(a), get(b), factor)
      if (primary !== 0 || !tiebreaker) return primary
      // Tiebreaker always applies ascending, regardless of the primary column's direction.
      return cmp(tiebreaker(a), tiebreaker(b), 1)
    })
  }, [rows, accessors, key, dir, tiebreaker])

  function toggleSort(nextKey: string) {
    if (nextKey === key) {
      setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setKey(nextKey)
      setDir('asc')
    }
  }

  function reset() {
    setKey(initialKey)
    setDir(initialDir)
  }

  const isDefault = key === initialKey && dir === initialDir

  return { sorted, sortKey: key, sortDir: dir, toggleSort, reset, isDefault }
}
