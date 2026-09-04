import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Plus } from 'lucide-react'

/**
 * A closed-by-default dropdown for picking one or more tag values, with an
 * optional search filter and an optional "add custom value" affordance for
 * values outside the suggested list.
 */
export default function TagSelect({
  placeholder,
  options,
  selected,
  onChange,
  multiple = true,
  creatable = false,
  searchPlaceholder = 'Search…',
}: {
  placeholder: string
  options: string[]
  selected: string[]
  onChange: (next: string[]) => void
  multiple?: boolean
  creatable?: boolean
  searchPlaceholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const q = query.trim().toLowerCase()
  const filtered = q ? options.filter((o) => o.toLowerCase().includes(q)) : options
  const canCreate =
    creatable &&
    query.trim() &&
    !options.some((o) => o.toLowerCase() === q) &&
    !selected.some((s) => s.toLowerCase() === q)

  function toggle(value: string) {
    if (multiple) {
      const next = selected.includes(value)
        ? selected.filter((s) => s !== value)
        : [...selected, value]
      onChange(next)
    } else {
      onChange(selected[0] === value ? [] : [value])
      setOpen(false)
    }
  }

  function create() {
    const v = query.trim()
    if (!v) return
    toggle(v)
    setQuery('')
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-left text-sm text-zinc-100 outline-none focus:border-indigo-500"
      >
        {selected.length === 0 ? (
          <span className="text-zinc-500">{placeholder}</span>
        ) : (
          <span className="flex flex-wrap items-center gap-1 overflow-hidden">
            <span className="rounded-full border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-200">
              {selected[0]}
            </span>
            {selected.length > 1 && (
              <span className="text-xs text-zinc-500">+{selected.length - 1} more</span>
            )}
          </span>
        )}
        <ChevronDown
          className={`size-4 shrink-0 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="absolute z-10 mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 shadow-xl">
          {(creatable || options.length > 6) && (
            <div className="border-b border-zinc-800 p-1.5">
              <input
                autoFocus
                className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-indigo-500"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canCreate) {
                    e.preventDefault()
                    create()
                  }
                }}
              />
            </div>
          )}
          <div className="max-h-56 overflow-y-auto p-1">
            {filtered.length === 0 && !canCreate && (
              <p className="px-2 py-1.5 text-xs text-zinc-500">No matches.</p>
            )}
            {filtered.map((o) => {
              const on = selected.includes(o)
              return (
                <button
                  key={o}
                  type="button"
                  onClick={() => toggle(o)}
                  className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm ${
                    on ? 'text-indigo-300' : 'text-zinc-200 hover:bg-zinc-800'
                  }`}
                >
                  {o}
                  {on && <Check className="size-3.5" />}
                </button>
              )
            })}
            {canCreate && (
              <button
                type="button"
                onClick={create}
                className="flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm text-indigo-300 hover:bg-indigo-950/40"
              >
                <Plus className="size-3.5" />
                Add “{query.trim()}”
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
