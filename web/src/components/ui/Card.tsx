/**
 * A titled surface panel. Lifted from the local copy that used to live in
 * pages/Dashboard.tsx. `actions` renders on the right of the header row.
 */
export default function Card({
  title,
  actions,
  className = '',
  id,
  children,
}: {
  title?: string
  actions?: React.ReactNode
  className?: string
  id?: string
  children: React.ReactNode
}) {
  return (
    <div
      id={id}
      className={`rounded-lg border border-line bg-surface/60 p-4 ${className}`}
    >
      {(title || actions) && (
        <div className="mb-2 flex items-center justify-between gap-3">
          {title && (
            <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
              {title}
            </h3>
          )}
          {actions}
        </div>
      )}
      {children}
    </div>
  )
}
