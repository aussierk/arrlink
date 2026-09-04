import { Loader2 } from 'lucide-react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost'
type Size = 'sm' | 'md'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-primary text-primary-fg hover:bg-primary-hover',
  secondary: 'border border-line-strong text-fg-soft hover:bg-fill',
  ghost: 'text-fg-soft hover:bg-fill',
  danger: 'bg-danger text-white hover:bg-danger-hover',
  'danger-ghost': 'text-danger-fg hover:bg-danger-bg',
}

const SIZE: Record<Size, string> = {
  sm: 'gap-1 rounded px-2.5 py-1 text-xs',
  md: 'gap-1.5 rounded-md px-3.5 py-1.5 text-sm',
}

/**
 * The one button. Replaces the copy-pasted Tailwind strings across the app.
 * Forwards every native <button> prop (type, onClick, disabled, aria-*); the
 * label is the caller's children so i18n stays at the call site. `loading`
 * shows a spinner and disables the button.
 */
export default function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  className = '',
  disabled,
  children,
  ...props
}: {
  variant?: Variant
  size?: Size
  loading?: boolean
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      disabled={disabled ?? loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center font-medium transition-colors focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50 ${SIZE[size]} ${VARIANT[variant]} ${className}`}
    >
      {loading && <Loader2 className="size-4 animate-spin" />}
      {children}
    </button>
  )
}
