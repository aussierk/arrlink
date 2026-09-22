import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Combobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from '@headlessui/react'
import { Check, ChevronDown, Plus, X } from 'lucide-react'

/**
 * A closed-by-default dropdown for picking one or more tag values, with an
 * optional search filter and an optional "add custom value" affordance for
 * values outside the suggested list.
 *
 * Built on Headless UI's <Combobox>, so it now has real listbox/option
 * semantics: arrow-key navigation, type-ahead, aria-expanded /
 * aria-activedescendant, and Escape-to-close.
 *
 * In multi-select mode, all selected values render as removable chips above
 * the picker (capped, with a "view all" expansion) so a large selection set
 * stays visible and editable without opening the dropdown. Props are
 * unchanged.
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
  const [expanded, setExpanded] = useState(false)

  const CHIP_LIMIT = 8
  const visibleChips =
    multiple && selected.length > 0
      ? expanded
        ? selected
        : selected.slice(0, CHIP_LIMIT)
      : []
  const hiddenChipCount = selected.length - visibleChips.length

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
        ) : multiple ? (
          <span className="text-fg">
            {t('tagSelect.selectedCount', { count: selected.length })}
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-1 overflow-hidden">
            <span className="rounded-full border border-line-strong bg-surface px-2 py-0.5 text-xs text-fg">
              {selected[0]}
            </span>
          </span>
        )}
        <ChevronDown className="size-4 shrink-0 text-fg-subtle transition-transform group-data-open:rotate-180" />
      </ComboboxButton>

      <ComboboxOptions
        anchor="bottom start"
        transition
        className="z-20 w-(--button-width) rounded-md border border-line-strong bg-surface shadow-xl [--anchor-gap:4px] empty:hidden data-leave:transition data-leave:duration-100 data-closed:opacity-0"
      >
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

  return (
    <div>
      {multiple && selected.length > 0 && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1">
          {visibleChips.map((v) => (
            <span
              key={v}
              className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface px-2 py-0.5 text-xs text-fg"
            >
              {v}
              <button
                type="button"
                onClick={() => commit(selected.filter((s) => s !== v))}
                aria-label={t('tagSelect.remove', { value: v })}
                className="rounded-full text-fg-subtle hover:text-danger-fg focus-visible:focus-ring"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {hiddenChipCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="text-xs text-accent hover:underline"
            >
              {t('tagSelect.showAll', { count: selected.length })}
            </button>
          )}
          {expanded && selected.length > CHIP_LIMIT && (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className="text-xs text-fg-subtle hover:underline"
            >
              {t('tagSelect.showFewer')}
            </button>
          )}
        </div>
      )}
      {multiple ? (
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
      )}
    </div>
  )
}
