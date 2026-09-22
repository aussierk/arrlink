import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Combobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from '@headlessui/react'
import { Check, ChevronDown } from 'lucide-react'
import { type ConditionCategory } from '../../lib/api'
import { CATEGORY_GROUP_ORDER, CATEGORY_META } from '../../lib/categoryMeta'
import { categoryLabel } from './helpers'

/**
 * The condition Category picker: a searchable, grouped combobox (Metadata /
 * Source / Technical / Numeric / Freeform, see categoryMeta.ts) instead of a
 * single flat 19-option <select>. `options` is already filtered to the
 * current service type (see categoriesForServiceType) -- e.g. `studio`
 * doesn't appear for a Sonarr-scoped rule.
 */
export default function CategorySelect({
  value,
  options,
  usedCategories,
  onChange,
}: {
  value: ConditionCategory
  options: ConditionCategory[]
  usedCategories: Set<string>
  onChange: (cat: ConditionCategory) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const groups = CATEGORY_GROUP_ORDER.map((group) => ({
    group,
    items: options.filter(
      (cat) =>
        CATEGORY_META[cat].group === group &&
        (!q || categoryLabel(cat).toLowerCase().includes(q)),
    ),
  })).filter((g) => g.items.length > 0)

  return (
    <Combobox
      immediate
      value={value}
      onChange={(next: ConditionCategory | null) => {
        if (next) onChange(next)
      }}
      onClose={() => setQuery('')}
    >
      <div className="relative">
        <ComboboxButton className="group flex w-full items-center justify-between gap-2 rounded-md border border-line-strong bg-sunken px-2 py-1.5 text-left text-sm text-fg focus-visible:focus-ring">
          <span>{categoryLabel(value)}</span>
          <ChevronDown className="size-4 shrink-0 text-fg-subtle transition-transform group-data-open:rotate-180" />
        </ComboboxButton>

        <ComboboxOptions className="absolute z-10 mt-1 w-full rounded-md border border-line-strong bg-surface shadow-xl empty:hidden">
          <div className="border-b border-line p-1.5">
            <ComboboxInput
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('tagSelect.search')}
              className="w-full rounded border border-line-strong bg-sunken px-2 py-1 text-sm text-fg outline-none focus:border-ring"
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {groups.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-fg-subtle">{t('tagSelect.noMatches')}</p>
            )}
            {groups.map(({ group, items }) => (
              <div key={group}>
                <p className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                  {t(`category.group.${group}`)}
                </p>
                {items.map((cat) => {
                  const disabled = usedCategories.has(cat) && cat !== value
                  return (
                    <ComboboxOption
                      key={cat}
                      value={cat}
                      disabled={disabled}
                      className="flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm text-fg data-disabled:cursor-not-allowed data-disabled:opacity-40 data-focus:bg-fill data-selected:text-accent"
                    >
                      {({ selected }) => (
                        <>
                          {categoryLabel(cat)}
                          {selected && <Check className="size-3.5 shrink-0" />}
                        </>
                      )}
                    </ComboboxOption>
                  )
                })}
              </div>
            ))}
          </div>
        </ComboboxOptions>
      </div>
    </Combobox>
  )
}
