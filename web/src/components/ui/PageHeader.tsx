import type { ReactNode } from 'react'

/**
 * Title + subtitle header used at the top of every page and every Settings
 * section. `size="lg"` is the page-level look (Rules/Tags/Logs/Dashboard),
 * `size="md"` the smaller Settings-section look. `actions` renders
 * right-aligned (e.g. an "Add rule" button).
 */
export default function PageHeader({
  title,
  subtitle,
  actions,
  size = 'lg',
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  size?: 'lg' | 'md'
}) {
  const titleCls =
    size === 'lg' ? 'text-xl font-semibold' : 'text-sm font-semibold text-fg'
  const subtitleCls = size === 'lg' ? 'text-sm text-fg-subtle' : 'text-xs text-fg-subtle'

  const Heading = size === 'lg' ? 'h2' : 'h3'

  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <Heading className={titleCls}>{title}</Heading>
        {subtitle && <p className={subtitleCls}>{subtitle}</p>}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  )
}
