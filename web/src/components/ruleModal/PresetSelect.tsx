import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Combobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from '@headlessui/react'
import { ChevronDown, Sparkles } from 'lucide-react'
import { type PresetItem } from '../../lib/api'
import { CATEGORY_GROUP_ORDER, CATEGORY_META } from '../../lib/categoryMeta'

/**
 * "Start from a preset" as a searchable, grouped combobox instead of a flat
 * button row -- scales past a handful of entries, and groups by the same
 * Metadata/Source/Technical/Numeric/Freeform taxonomy as the condition
 * category picker (see categoryMeta.ts). Applying a preset is a one-shot
 * action, not a persisted selection, so this never shows a "current value".
 */
export default function PresetSelect({
  presets,
  onSelect,
}: {
  presets: PresetItem[]
  onSelect: (p: PresetItem) => void
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')

  const q = query.trim().toLowerCase()
  const groups = CATEGORY_GROUP_ORDER.map((group) => ({
    group,
    items: presets.filter(
      (p) =>
        CATEGORY_META[p.category]?.group === group &&
        (!q ||
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q)),
    ),
  })).filter((g) => g.items.length > 0)

  return (
    <Combobox
      immediate
      value={null}
      onChange={(p: PresetItem | null) => {
        if (p) onSelect(p)
      }}
      onClose={() => setQuery('')}
    >
      <div className="relative">
        <ComboboxButton className="group flex w-full items-center justify-between gap-2 rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-left text-sm text-fg focus-visible:focus-ring">
          <span className="flex items-center gap-1.5 text-accent">
            <Sparkles className="size-3.5" />
            {t('ruleModal.startFromPreset')}
          </span>
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
          <div className="max-h-80 overflow-y-auto p-1">
            {groups.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-fg-subtle">
                {presets.length === 0 ? t('ruleModal.noPresets') : t('tagSelect.noMatches')}
              </p>
            )}
            {groups.map(({ group, items }) => (
              <div key={group}>
                <p className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">
                  {t(`category.group.${group}`)}
                </p>
                {items.map((p) => (
                  <ComboboxOption
                    key={p.key}
                    value={p}
                    title={p.dir_template}
                    className="flex w-full cursor-pointer flex-col gap-0.5 rounded px-2 py-1.5 text-left data-focus:bg-fill"
                  >
                    <span className="text-sm text-fg">{p.name}</span>
                    <span className="text-xs text-fg-subtle">{p.description}</span>
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
