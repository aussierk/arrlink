/**
 * Inline status banner — error or success. Renders nothing when `children`
 * is falsy, so call sites can do `<Alert variant="error">{err}</Alert>`
 * unchanged in shape from the copy-pasted div it replaces.
 */
export default function Alert({
  variant,
  children,
}: {
  variant: 'error' | 'success'
  children: React.ReactNode
}) {
  if (!children) return null
  const cls =
    variant === 'error'
      ? 'border-danger-line bg-danger-bg text-danger-fg'
      : 'border-success-line bg-success-bg text-success-fg'
  return <div className={`rounded-md border p-3 text-sm ${cls}`}>{children}</div>
}
