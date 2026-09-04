import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { REGEX_PICKS } from '../../lib/tagOptions'
import {
  type ConditionCategory,
  type ConditionItem,
  type ConditionSource,
} from '../../lib/api'
import { inputCls } from '../../lib/ui'
import Field from '../ui/Field'
import TagSelect from '../ui/TagSelect'
import {
  CATEGORY_ORDER,
  CUSTOM,
  RICH,
  categoryLabel,
  creatableFor,
  selectedFor,
} from './helpers'

type Props = {
  condition: ConditionItem
  index: number
  total: number
  usedCategories: Set<string>
  optionsFor: (category: ConditionCategory) => string[]
  onUpdate: (patch: Partial<ConditionItem>) => void
  onToggleJoin: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onRemove: () => void
  onApplySelection: (prevSelected: string[], next: string[]) => void
}

/** One row of the AND/OR condition chain: reorder rail, category / match-type
 * / match-source selects, and the value editor. */
export default function ConditionRow({
  condition: c,
  index: i,
  total,
  usedCategories,
  optionsFor,
  onUpdate,
  onToggleJoin,
  onMoveUp,
  onMoveDown,
  onRemove,
  onApplySelection,
}: Props) {
  const { t } = useTranslation()
  const selected = selectedFor(c)

  function renderValue() {
    if (c.match_type === 'vocabulary') {
      const known = optionsFor(c.category)
      return (
        <p className="rounded-md border border-line bg-sunken/40 px-3 py-2 text-xs text-fg-muted">
          {t('ruleModal.vocabularyMatchHint', { count: known.length })}
        </p>
      )
    }

    if (c.category === 'user' && c.match_type === 'regex') {
      const regexPick = REGEX_PICKS.find((p) => p.pattern === c.match_value)
      const regexIsCustom = !!c.match_value && !regexPick
      return (
        <div className="space-y-2">
          <select
            className={inputCls}
            value={regexIsCustom ? CUSTOM : (regexPick?.pattern ?? '')}
            onChange={(e) => {
              const v = e.target.value
              onUpdate({ match_value: v === CUSTOM ? c.match_value || '' : v })
            }}
          >
            <option value="">{t('ruleModal.selectPattern')}</option>
            {REGEX_PICKS.map((p) => (
              <option key={p.pattern} value={p.pattern}>
                {p.label}
              </option>
            ))}
            <option value={CUSTOM}>{t('ruleModal.customRegex')}</option>
          </select>
          {regexPick?.hint && <p className="text-xs text-fg-subtle">{regexPick.hint}</p>}
          {regexIsCustom && (
            <textarea
              className={inputCls + ' font-mono'}
              rows={2}
              value={c.match_value}
              onChange={(e) => onUpdate({ match_value: e.target.value })}
              placeholder={t('ruleModal.customRegexPlaceholder')}
            />
          )}
        </div>
      )
    }

    return (
      <TagSelect
        placeholder={
          c.match_type === 'regex'
            ? t('ruleModal.pickOrTypePattern')
            : t('ruleModal.selectCategoryPlaceholder', {
                category: categoryLabel(c.category).toLowerCase(),
              })
        }
        options={optionsFor(c.category)}
        selected={selected}
        onChange={(next) => onApplySelection(selected, next)}
        multiple={c.match_type === 'list'}
        creatable={creatableFor(c.match_type)}
        searchPlaceholder={
          c.match_type === 'regex'
            ? t('ruleModal.searchOrTypePattern')
            : t('ruleModal.searchOrAdd')
        }
      />
    )
  }

  return (
    <div>
      {i > 0 && (
        <div className="flex justify-center py-1">
          <button
            type="button"
            onClick={onToggleJoin}
            className="rounded bg-fill px-2 py-0.5 text-xs font-semibold text-accent hover:bg-line-strong"
          >
            {c.join === 'AND' ? t('conditions.joinAnd') : t('conditions.joinOr')}
          </button>
        </div>
      )}
      <div className="flex gap-3 rounded-md border border-line bg-sunken/30 p-3">
        <div className="flex shrink-0 flex-col items-center gap-1">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={i === 0}
            aria-label={t('ruleModal.moveConditionUp', { number: i + 1 })}
            className="rounded border border-line-strong p-0.5 text-fg-muted transition-colors hover:bg-fill hover:text-fg focus-visible:focus-ring disabled:opacity-25"
          >
            <ChevronUp className="size-4" />
          </button>
          <span
            className="text-sm font-semibold tabular-nums text-fg-muted"
            aria-hidden="true"
          >
            {i + 1}
          </span>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={i === total - 1}
            aria-label={t('ruleModal.moveConditionDown', { number: i + 1 })}
            className="rounded border border-line-strong p-0.5 text-fg-muted transition-colors hover:bg-fill hover:text-fg focus-visible:focus-ring disabled:opacity-25"
          >
            <ChevronDown className="size-4" />
          </button>
        </div>
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex items-center justify-between">
            <span
              className="text-sm font-medium text-fg"
              aria-label={t('ruleModal.conditionNumber', { number: i + 1 })}
            >
              {t('ruleModal.conditionLabel')}
            </span>
            <button
              type="button"
              onClick={onRemove}
              disabled={total <= 1}
              aria-label={t('ruleModal.removeCondition', { number: i + 1 })}
              className="rounded p-1 text-fg-subtle transition-colors hover:bg-danger-bg hover:text-danger-fg focus-visible:focus-ring disabled:opacity-25"
            >
              <X className="size-4" />
            </button>
          </div>
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('ruleModal.category')}>
                <select
                  className={inputCls}
                  value={c.category}
                  onChange={(e) => {
                    const cat = e.target.value as ConditionCategory
                    onUpdate({
                      category: cat,
                      // Users has no literal tag suggestions — regex (the
                      // "## - username" style pick) is the only mode that
                      // actually extracts a username, so switching to it
                      // defaults there. Still overridable via Match Type.
                      match_type: cat === 'user' ? 'regex' : c.match_type,
                      match_value: '',
                    })
                  }}
                >
                  {CATEGORY_ORDER.map((cat) => (
                    <option
                      key={cat}
                      value={cat}
                      disabled={usedCategories.has(cat) && cat !== c.category}
                    >
                      {categoryLabel(cat)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('ruleModal.matchType')}>
                <select
                  className={inputCls}
                  value={c.match_type}
                  onChange={(e) =>
                    onUpdate({
                      match_type: e.target.value as ConditionItem['match_type'],
                      match_value: '',
                    })
                  }
                >
                  <option value="list">{t('ruleModal.matchTypeListOption')}</option>
                  <option value="exact">{t('ruleModal.matchTypeExactOption')}</option>
                  <option value="regex">{t('ruleModal.matchTypeRegex')}</option>
                  {RICH.has(c.category) && (
                    <option value="vocabulary">
                      {t('ruleModal.matchTypeVocabulary')}
                    </option>
                  )}
                </select>
              </Field>
            </div>
            {RICH.has(c.category) && (
              <Field label={t('ruleModal.matchSource')}>
                <div className="flex gap-1.5">
                  {(['tag', 'native'] as ConditionSource[]).map((src) => (
                    <button
                      key={src}
                      type="button"
                      onClick={() => onUpdate({ source: src === 'tag' ? null : src })}
                      className={
                        'rounded-md border px-3 py-1 text-xs ' +
                        ((c.source ?? 'tag') === src
                          ? 'border-ring bg-accent-bg text-accent'
                          : 'border-line-strong text-fg-muted hover:bg-fill')
                      }
                    >
                      {src === 'tag'
                        ? t('ruleModal.sourceTag')
                        : t('ruleModal.sourceNative')}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-xs text-fg-subtle">
                  {(c.source ?? 'tag') === 'native'
                    ? t('ruleModal.sourceNativeHint')
                    : t('ruleModal.sourceTagHint')}
                </p>
              </Field>
            )}
            <Field label={t('ruleModal.value')}>{renderValue()}</Field>
          </div>
        </div>
      </div>
    </div>
  )
}
