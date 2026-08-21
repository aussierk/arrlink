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
      ? 'border-red-900 bg-red-950/40 text-red-300'
      : 'border-emerald-900 bg-emerald-950/40 text-emerald-300'
  return <div className={`rounded-md border p-3 text-sm ${cls}`}>{children}</div>
}
