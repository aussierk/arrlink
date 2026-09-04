import { useMemo, useState } from 'react'

export type SortDir = 'asc' | 'desc'

type Accessor<T> = (row: T) => string | number | null | undefined

/**
 * Client-side column sorting for a table. `accessors` maps a column key to a
 * value getter; pass it as a module-level constant so it stays referentially
 * stable across renders. Nulls always sort last regardless of direction;
 * strings compare with locale + numeric awareness ("q2" before "q10").
 */
export function useSort<T>(
  rows: T[],
  accessors: Record<string, Accessor<T>>,
  initialKey: string,
  initialDir: SortDir = 'asc',
) {
  const [key, setKey] = useState(initialKey)
  const [dir, setDir] = useState<SortDir>(initialDir)

  const sorted = useMemo(() => {
    const get = accessors[key]
    if (!get) return rows
    const factor = dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = get(a)
      const bv = get(b)
      const aNull = av == null || av === ''
      const bNull = bv == null || bv === ''
      if (aNull && bNull) return 0
      if (aNull) return 1
      if (bNull) return -1
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * factor
    })
  }, [rows, accessors, key, dir])

  function toggleSort(nextKey: string) {
    if (nextKey === key) {
      setDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setKey(nextKey)
      setDir('asc')
    }
  }

  return { sorted, sortKey: key, sortDir: dir, toggleSort }
}
