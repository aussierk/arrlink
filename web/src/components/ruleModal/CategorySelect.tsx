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
import { CATEGORY_GROUP_ORDER, CATEGORY_META, type CategoryGroup } from '../../lib/categoryMeta'
import { categoryLabel } from './helpers'

type PickerEntry = {
  key: string
  // The concrete category this entry currently represents -- for a merged
  // entry (see categoryMeta.ts's mergeGroup), this is whichever variant the
  // row is already on, or the first not-yet-used variant otherwise.
  category: ConditionCategory
  label: string
  group: CategoryGroup
  disabled: boolean
}

/** Collapses `options` into picker entries, merging categories that share a
 * `mergeGroup` (currently just language/audio_language) into one "Language"
 * entry so the picker offers one slot per real-world concept instead of one
 * per stored field. */
function buildEntries(
  options: ConditionCategory[],
  value: ConditionCategory,
  usedCategories: Set<string>,
  mergedLabel: (group: string) => string,
): PickerEntry[] {
  const seenMergeGroups = new Set<string>()
  const entries: PickerEntry[] = []
  for (const cat of options) {
    const meta = CATEGORY_META[cat]
    if (meta.mergeGroup) {
      if (seenMergeGroups.has(meta.mergeGroup)) continue
      seenMergeGroups.add(meta.mergeGroup)
      const variants = options.filter((c) => CATEGORY_META[c].mergeGroup === meta.mergeGroup)
      const active = variants.includes(value)
      entries.push({
        key: meta.mergeGroup,
        category: active ? value : (variants.find((v) => !usedCategories.has(v)) ?? variants[0]),
        label: mergedLabel(meta.mergeGroup),
        group: meta.group,
        disabled: !active && variants.every((v) => usedCategories.has(v)),
      })
    } else {
      entries.push({
        key: cat,
        category: cat,
        label: categoryLabel(cat),
        group: meta.group,
        disabled: usedCategories.has(cat) && cat !== value,
      })
    }
  }
  return entries
}

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

  const entries = buildEntries(options, value, usedCategories, (group) =>
    t(`category.mergedLabel.${group}`),
  )
  const activeEntry = entries.find((e) => e.category === value || e.key === value)
  const q = query.trim().toLowerCase()
  const groups = CATEGORY_GROUP_ORDER.map((group) => ({
    group,
    items: entries.filter((e) => e.group === group && (!q || e.label.toLowerCase().includes(q))),
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
          <span>{activeEntry?.label ?? categoryLabel(value)}</span>
          <ChevronDown className="size-4 shrink-0 text-fg-subtle transition-transform group-data-open:rotate-180" />
        </ComboboxButton>

        <ComboboxOptions
          anchor="bottom start"
          transition
          className="z-20 w-(--button-width) rounded-md border border-line-strong bg-surface shadow-xl [--anchor-gap:4px] empty:hidden data-leave:transition data-leave:duration-100 data-closed:opacity-0"
        >
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
                {items.map((entry) => (
                  <ComboboxOption
                    key={entry.key}
                    value={entry.category}
                    disabled={entry.disabled}
                    className="flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm text-fg data-disabled:cursor-not-allowed data-disabled:opacity-40 data-focus:bg-fill data-selected:text-accent"
                  >
                    {({ selected }) => (
                      <>
                        {entry.label}
                        {selected && <Check className="size-3.5 shrink-0" />}
                      </>
                    )}
                  </ComboboxOption>
                ))}
              </div>
            ))}
          </div>
        </ComboboxOptions>
      </div>
    </Combobox>
  )
}
