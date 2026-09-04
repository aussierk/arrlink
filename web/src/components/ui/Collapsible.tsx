import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

/**
 * A disclosure section: header + chevron toggles visibility of its content.
 * Uncontrolled by default (`defaultOpen` seeds internal state); pass `open` +
 * `onOpenChange` to drive it from a parent instead (e.g. to collapse a
 * finished item when a sibling becomes active).
 */
export default function Collapsible({
  title,
  defaultOpen = false,
  open,
  onOpenChange,
  badge,
  children,
}: {
  title: string
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  badge?: React.ReactNode
  children: React.ReactNode
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const isOpen = open ?? uncontrolledOpen

  function toggle() {
    if (onOpenChange) onOpenChange(!isOpen)
    if (open === undefined) setUncontrolledOpen((o) => !o)
  }

  return (
    <div className="border-t border-line pt-3 first:border-t-0 first:pt-0">
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
          {isOpen ? (
            <ChevronDown className="size-4 text-fg-subtle" />
          ) : (
            <ChevronRight className="size-4 text-fg-subtle" />
          )}
          {title}
        </span>
        {!isOpen && badge && <span className="text-xs text-fg-subtle">{badge}</span>}
      </button>
      {isOpen && <div className="mt-3 space-y-3">{children}</div>}
    </div>
  )
}
