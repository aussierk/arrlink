/** A label + control row. Stacks (label above control) on narrow screens;
 * from sm up it's a fixed-width label beside a flexible control area. */
export default function Field({
  label,
  children,
}: {
  label: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-4">
      <span className="text-sm text-fg-muted sm:w-48 sm:shrink-0 sm:pt-1.5">{label}</span>
      <div className="min-w-0 flex-1 space-y-1 text-sm">{children}</div>
    </div>
  )
}
