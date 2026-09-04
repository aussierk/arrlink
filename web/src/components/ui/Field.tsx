/** A label-beside-control row: fixed-width label, flexible control area. */
export default function Field({
  label,
  children,
}: {
  label: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-4">
      <span className="w-48 shrink-0 pt-1.5 text-sm text-fg-muted">{label}</span>
      <div className="min-w-0 flex-1 space-y-1 text-sm">{children}</div>
    </div>
  )
}
