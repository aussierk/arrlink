import { ChevronDown, ChevronsUpDown, ChevronUp } from 'lucide-react'
import type { SortDir } from '../../lib/useSort'

/** A clickable table header that drives useSort. Shows a neutral glyph when
 * inactive and a direction arrow when it's the active sort column. */
export default function SortHeader({
  label,
  columnKey,
  activeKey,
  dir,
  onSort,
  className = '',
}: {
  label: string
  columnKey: string
  activeKey: string
  dir: SortDir
  onSort: (key: string) => void
  className?: string
}) {
  const active = columnKey === activeKey
  const Icon = !active ? ChevronsUpDown : dir === 'asc' ? ChevronUp : ChevronDown
  return (
    <th
      scope="col"
      className={`px-3 py-2 ${className}`}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(columnKey)}
        className="inline-flex items-center gap-1 rounded hover:text-fg focus-visible:focus-ring"
      >
        {label}
        <Icon className={`size-3 ${active ? 'text-accent' : 'text-fg-faint'}`} />
      </button>
    </th>
  )
}
