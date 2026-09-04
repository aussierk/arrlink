import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Combobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from '@headlessui/react'
import { Check, ChevronDown, Plus } from 'lucide-react'

/**
 * A closed-by-default dropdown for picking one or more tag values, with an
 * optional search filter and an optional "add custom value" affordance for
 * values outside the suggested list.
 *
 * Built on Headless UI's <Combobox>, so it now has real listbox/option
 * semantics: arrow-key navigation, type-ahead, aria-expanded /
 * aria-activedescendant, and Escape-to-close. Props are unchanged.
 */
export default function TagSelect({
  placeholder,
  options,
  selected,
  onChange,
  multiple = true,
  creatable = false,
  searchPlaceholder,
}: {
  placeholder: string
  options: string[]
  selected: string[]
  onChange: (next: string[]) => void
  multiple?: boolean
  creatable?: boolean
  searchPlaceholder?: string
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const filtered = q ? options.filter((o) => o.toLowerCase().includes(q)) : options
  const canCreate =
    creatable &&
    !!query.trim() &&
    !options.some((o) => o.toLowerCase() === q) &&
    !selected.some((s) => s.toLowerCase() === q)
  const showSearch = creatable || options.length > 6

  function commit(next: string[]) {
    onChange(next)
    // Clear the filter after adding a freshly-created value (mirrors the old
    // create() behaviour); leave it otherwise so several matches can be
    // picked in a row.
    if (next.some((v) => !options.includes(v))) setQuery('')
  }

  const inner = (
    <div className="relative">
      <ComboboxButton className="group flex w-full items-center justify-between gap-2 rounded-md border border-line-strong bg-sunken px-2 py-1.5 text-left text-sm text-fg focus-visible:focus-ring">
        {selected.length === 0 ? (
          <span className="text-fg-subtle">{placeholder}</span>
        ) : (
          <span className="flex flex-wrap items-center gap-1 overflow-hidden">
            <span className="rounded-full border border-line-strong bg-surface px-2 py-0.5 text-xs text-fg">
              {selected[0]}
            </span>
            {selected.length > 1 && (
              <span className="text-xs text-fg-subtle">+{selected.length - 1} more</span>
            )}
          </span>
        )}
        <ChevronDown className="size-4 shrink-0 text-fg-subtle transition-transform group-data-open:rotate-180" />
      </ComboboxButton>

      <ComboboxOptions className="absolute z-10 mt-1 w-full rounded-md border border-line-strong bg-surface shadow-xl empty:hidden">
        {showSearch && (
          <div className="border-b border-line p-1.5">
            <ComboboxInput
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder ?? t('tagSelect.search')}
              className="w-full rounded border border-line-strong bg-sunken px-2 py-1 text-sm text-fg outline-none focus:border-ring"
            />
          </div>
        )}
        <div className="max-h-56 overflow-y-auto p-1">
          {filtered.length === 0 && !canCreate && (
            <p className="px-2 py-1.5 text-xs text-fg-subtle">
              {t('tagSelect.noMatches')}
            </p>
          )}
          {filtered.map((o) => (
            <ComboboxOption
              key={o}
              value={o}
              className="flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm text-fg data-focus:bg-fill data-selected:text-accent"
            >
              {({ selected: on }) => (
                <>
                  {o}
                  {on && <Check className="size-3.5" />}
                </>
              )}
            </ComboboxOption>
          ))}
          {canCreate && (
            <ComboboxOption
              value={query.trim()}
              className="flex w-full cursor-pointer items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm text-accent data-focus:bg-accent-bg"
            >
              <Plus className="size-3.5" />
              {t('tagSelect.add', { value: query.trim() })}
            </ComboboxOption>
          )}
        </div>
      </ComboboxOptions>
    </div>
  )

  return multiple ? (
    <Combobox
      immediate
      multiple
      value={selected}
      onChange={commit}
      onClose={() => setQuery('')}
    >
      {inner}
    </Combobox>
  ) : (
    <Combobox
      immediate
      value={selected[0] ?? null}
      onChange={(next: string | null) => commit(next ? [next] : [])}
      onClose={() => setQuery('')}
    >
      {inner}
    </Combobox>
  )
}
