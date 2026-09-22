import type { ReactNode, TableHTMLAttributes, ThHTMLAttributes } from 'react'

/**
 * Shared table structure -- replaces the copy-pasted wrapper/thead/th/empty-row
 * markup that used to be hand-rolled per page. Sortable header cells still
 * use `SortHeader` directly (it's already its own `<th>`).
 */
export function Table({
  className = '',
  children,
  ...props
}: { className?: string } & TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table {...props} className={`w-full text-sm ${className}`}>
        {children}
      </table>
    </div>
  )
}

export function Thead({
  className = '',
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <thead
      className={`bg-surface text-left text-xs font-semibold text-fg-muted ${className}`}
    >
      {children}
    </thead>
  )
}

export function Th({
  className = '',
  children,
  ...props
}: { className?: string } & ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th scope="col" {...props} className={`px-3 py-2 ${className}`}>
      {children}
    </th>
  )
}

/** The empty/no-match state row, spanning the full table width. */
export function TableEmpty({
  colSpan,
  children,
}: {
  colSpan: number
  children: ReactNode
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-6 text-center text-fg-subtle">
        {children}
      </td>
    </tr>
  )
}
