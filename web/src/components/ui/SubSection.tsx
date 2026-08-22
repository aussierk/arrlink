/**
 * A bordered, always-visible sub-block within a settings section (as
 * opposed to `Collapsible`, which hides its content behind a disclosure
 * toggle) — for grouping related fields (e.g. "OIDC settings") or reference
 * panels that should stay visible while the surrounding page is open.
 * `header` renders next to `title` (e.g. an "Enable" toggle or a button).
 */
export default function SubSection({
  title,
  header,
  children,
}: {
  title?: string
  header?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="space-y-3">
      {(title || header) && (
        <div className="flex items-center justify-between gap-3">
          {title && <h4 className="text-sm font-medium text-zinc-200">{title}</h4>}
          {header}
        </div>
      )}
      {children}
    </div>
  )
}
