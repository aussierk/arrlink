/** A pill-track switch replacing raw checkboxes for boolean settings. */
export default function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: React.ReactNode
  disabled?: boolean
}) {
  return (
    <label
      className={`flex items-center gap-2 text-sm text-fg-soft ${
        disabled ? 'opacity-50' : 'cursor-pointer'
      }`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          checked ? 'bg-primary' : 'bg-line-strong'
        } ${disabled ? '' : 'cursor-pointer'}`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-[18px]' : 'translate-x-1'
          }`}
        />
      </button>
      {label}
    </label>
  )
}
