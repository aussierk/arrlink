/** A label-beside-control row: fixed-width label, flexible control area. */
export default function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-4">
      <span className="w-36 shrink-0 text-sm text-zinc-400">{label}</span>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  )
}
