import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import RuleModal from '../components/RuleModal'
import Button from '../components/ui/Button'
import PageHeader from '../components/ui/PageHeader'
import SortHeader from '../components/ui/SortHeader'
import { Table, TableEmpty, Th, Thead } from '../components/ui/Table'
import { encodeServiceValue } from '../components/ruleModal/helpers'
import { pruneSelection } from '../lib/pruneSelection'
import { useAsyncLoad } from '../lib/useAsyncLoad'
import { useConfirm } from '../lib/useConfirm'
import { useSort } from '../lib/useSort'
import { useToast } from '../lib/useToast'
import {
  api,
  type ConditionCategory,
  type ConditionItem,
  type RuleInput,
  type RuleItem,
} from '../lib/api'
import { REGEX_PICKS } from '../lib/tagOptions'
import { selectCls } from '../lib/ui'
import i18n from '../i18n'

const filterCls =
  'w-56 rounded-md border border-line-strong bg-sunken px-2 py-1.5 text-sm text-fg outline-none focus:border-ring focus-visible:focus-ring'

const RULE_SORT: Record<string, (r: RuleItem) => string | number> = {
  name: (r) => r.name.toLowerCase(),
  app: (r) => r.app_name ?? r.app_type_scope ?? '',
  priority: (r) => r.priority,
}

const MATCH_TYPES: ConditionItem['match_type'][] = [
  'exact',
  'list',
  'regex',
  'vocabulary',
]

const MATCH_TYPE_LABEL_KEY: Record<string, string> = {
  exact: 'rules.matchTypeLabel.exact',
  list: 'rules.matchTypeLabel.list',
  regex: 'rules.matchTypeLabel.regex',
  vocabulary: 'rules.matchTypeLabel.vocabulary',
}

const CATEGORIES: ConditionCategory[] = [
  'user',
  'genre',
  'language',
  'audio_language',
  'quality',
  'certification',
  'collection',
  'custom',
]

const CATEGORY_LABEL_KEY: Record<string, string> = {
  user: 'rules.categoryLabel.user',
  genre: 'rules.categoryLabel.genre',
  language: 'rules.categoryLabel.language',
  audio_language: 'rules.categoryLabel.audio_language',
  quality: 'rules.categoryLabel.quality',
  certification: 'rules.categoryLabel.certification',
  collection: 'rules.categoryLabel.collection',
  custom: 'rules.categoryLabel.custom',
}

/** Render one condition's match value readably: exact as-is, list as
 * comma-joined text + "N more", regex as a friendly label when it's a known
 * pattern (else a short mono snippet). Not a component (used inline in a
 * table cell builder), so it reads translations off the i18next singleton
 * instead of the useTranslation hook. */
function conditionValueNode(c: ConditionItem): ReactNode {
  const t = i18n.t
  if (c.match_type === 'list') {
    const tags = c.match_value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const shown = tags.slice(0, 3).join(', ')
    const more = tags.length - Math.min(tags.length, 3)
    return (
      <span className="text-fg-soft">
        {shown}
        {more > 0 && (
          <span className="text-fg-subtle"> {t('rules.matchMore', { count: more })}</span>
        )}
      </span>
    )
  }
  if (c.match_type === 'regex') {
    const pick = REGEX_PICKS.find((p) => p.pattern === c.match_value)
    return (
      <span className={pick ? 'text-fg-soft' : 'break-all font-mono text-fg-soft'}>
        {pick ? pick.label : c.match_value}
      </span>
    )
  }
  return <span className="text-fg-soft">{c.match_value}</span>
}

type ConditionRow = {
  key: number
  join: ReactNode | null
  category: ReactNode
  type: ReactNode
  value: ReactNode
}

/** One entry per condition, in order. The Category/Type/Value <td>s each map
 * over this same array so their lines stay aligned across the row -- a
 * multi-condition rule renders as one line per condition in every column. */
function conditionRows(r: RuleItem): ConditionRow[] {
  const t = i18n.t
  return r.conditions.map((c, i) => ({
    key: i,
    join:
      i > 0 ? (
        <span className="rounded bg-fill px-1 text-[10px] font-semibold text-accent">
          {c.join === 'AND' ? t('conditions.joinAnd') : t('conditions.joinOr')}
        </span>
      ) : null,
    category: (
      <span className="whitespace-nowrap text-fg-subtle">
        {CATEGORY_LABEL_KEY[c.category] ? t(CATEGORY_LABEL_KEY[c.category]) : c.category}
      </span>
    ),
    type: (
      <span className="whitespace-nowrap text-fg-subtle">
        {t(MATCH_TYPE_LABEL_KEY[c.match_type])}
      </span>
    ),
    value: conditionValueNode(c),
  }))
}

/**
 * Rules: the single place to build and edit rules. "Add rule" opens the rule
 * modal, which includes a "start from a preset" quick-start and its own Live
 * Preview. A row's name can be double-clicked (or Enter'd, when focused) to
 * edit it; checkboxes drive bulk enable/disable/delete for everything else.
 */
export default function Rules() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const toast = useToast()
  const [rules, setRules] = useState<RuleItem[]>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<RuleItem | null>(null)
  const [vocabWarnings, setVocabWarnings] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [serviceFilter, setServiceFilter] = useState('')
  const [matchTypeFilter, setMatchTypeFilter] = useState<
    ConditionItem['match_type'] | ''
  >('')
  const [categoryFilter, setCategoryFilter] = useState<ConditionCategory | ''>('')
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const selectAllRef = useRef<HTMLInputElement>(null)

  // Whatever column is sorted becomes the primary key; rows that tie on it
  // always fall back to priority order (the rule engine's real evaluation
  // order) -- there's no visible Priority column, so `resetSort` below is
  // the only way back to it once another header has been clicked.
  const {
    sorted: sortedRules,
    sortKey,
    sortDir,
    toggleSort,
    reset: resetSort,
    isDefault: isDefaultSort,
  } = useSort(rules, RULE_SORT, 'priority', 'asc', (r) => r.priority)

  function serviceLabel(appName: string | null, appTypeScope: string | null): string {
    return (
      appName ??
      (appTypeScope === 'radarr'
        ? t('ruleModal.allRadarr')
        : appTypeScope === 'sonarr'
          ? t('ruleModal.allSonarr')
          : t('rules.any'))
    )
  }

  const serviceOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of rules) {
      const value = encodeServiceValue(r.app_scope, r.app_type_scope)
      if (!seen.has(value)) seen.set(value, serviceLabel(r.app_name, r.app_type_scope))
    }
    return Array.from(seen, ([value, label]) => ({ value, label })).sort((a, b) =>
      a.label.localeCompare(b.label),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules])

  const q = filter.trim().toLowerCase()
  const visibleRules = sortedRules.filter((r) => {
    if (q && !r.name.toLowerCase().includes(q)) return false
    if (
      serviceFilter &&
      encodeServiceValue(r.app_scope, r.app_type_scope) !== serviceFilter
    ) {
      return false
    }
    if (matchTypeFilter && !r.conditions.some((c) => c.match_type === matchTypeFilter)) {
      return false
    }
    if (categoryFilter && !r.conditions.some((c) => c.category === categoryFilter)) {
      return false
    }
    return true
  })
  const hasActiveFilter = Boolean(q || serviceFilter || matchTypeFilter || categoryFilter)

  function clearFilters() {
    setFilter('')
    setServiceFilter('')
    setMatchTypeFilter('')
    setCategoryFilter('')
  }

  // A selection can outlive the filter that made it visible -- prune it down
  // to still-visible rows whenever the filtered set actually changes (keyed
  // on the id list, not the array reference, so this doesn't fire every render).
  const visibleIdsKey = visibleRules.map((r) => r.id).join(',')
  useEffect(() => {
    const visibleIds = new Set(visibleRules.map((r) => r.id))
    setSelectedIds((prev) => pruneSelection(prev, visibleIds))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleIdsKey])

  const allVisibleSelected =
    visibleRules.length > 0 && visibleRules.every((r) => selectedIds.has(r.id))
  const someVisibleSelected = visibleRules.some((r) => selectedIds.has(r.id))

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someVisibleSelected && !allVisibleSelected
    }
  }, [someVisibleSelected, allVisibleSelected])

  function toggleSelected(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        for (const r of visibleRules) next.delete(r.id)
      } else {
        for (const r of visibleRules) next.add(r.id)
      }
      return next
    })
  }

  function clearSelection() {
    setSelectedIds(new Set())
  }

  const load = useAsyncLoad(async () => {
    setRules(await api.listRules())
  }, [])

  function openNew() {
    setEditing(null)
    setModalOpen(true)
  }

  function openEdit(r: RuleItem) {
    setEditing(r)
    setModalOpen(true)
  }

  function ruleToInput(r: RuleItem, overrides?: Partial<RuleInput>): RuleInput {
    return {
      name: r.name,
      app_scope: r.app_scope,
      app_type_scope: r.app_type_scope,
      conditions: r.conditions,
      dir_template: r.dir_template,
      filename_template: r.filename_template,
      dir_naming_mode: r.dir_naming_mode,
      enabled: r.enabled,
      unlink_on_mismatch: r.unlink_on_mismatch,
      priority: r.priority,
      ...overrides,
    }
  }

  function bulkEditSingle() {
    if (selectedIds.size !== 1) return
    const [id] = selectedIds
    const rule = rules.find((r) => r.id === id)
    if (rule) openEdit(rule)
  }

  async function bulkSetEnabled(enabled: boolean) {
    const ids = [...selectedIds]
    setBulkBusy(true)
    try {
      await Promise.all(
        ids.map((id) => {
          const rule = rules.find((r) => r.id === id)
          return rule
            ? api.updateRule(id, ruleToInput(rule, { enabled }))
            : Promise.resolve()
        }),
      )
      toast.success(
        t(enabled ? 'rules.bulkEnabledMsg' : 'rules.bulkDisabledMsg', {
          count: ids.length,
        }),
      )
      clearSelection()
      await load()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBulkBusy(false)
    }
  }

  async function bulkDelete() {
    const ids = [...selectedIds]
    const ok = await confirm({
      title: t('rules.deleteTitle'),
      message: t('rules.bulkDeleteConfirm', { count: ids.length }),
      variant: 'danger',
    })
    if (!ok) return
    setBulkBusy(true)
    try {
      await Promise.all(ids.map((id) => api.deleteRule(id)))
      toast.success(t('rules.bulkDeletedMsg', { count: ids.length }))
      clearSelection()
      await load()
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBulkBusy(false)
    }
  }

  function handleNameKeyDown(e: React.KeyboardEvent, r: RuleItem) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openEdit(r)
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('rules.title')}
        subtitle={t('rules.subtitle')}
        actions={
          <Button onClick={openNew} className="whitespace-nowrap">
            {t('rules.addRule')}
          </Button>
        }
      />

      {rules.length > 0 &&
        (selectedIds.size > 0 ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md bg-accent-bg p-2">
            <span className="px-1 text-xs font-medium text-accent">
              {t('rules.selectedCount', { count: selectedIds.size })}
            </span>
            {selectedIds.size === 1 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={bulkEditSingle}
                disabled={bulkBusy}
              >
                {t('rules.bulkEdit')}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void bulkSetEnabled(true)}
              disabled={bulkBusy}
            >
              {t('rules.bulkEnable')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void bulkSetEnabled(false)}
              disabled={bulkBusy}
            >
              {t('rules.bulkDisable')}
            </Button>
            <Button
              variant="danger-ghost"
              size="sm"
              onClick={() => void bulkDelete()}
              disabled={bulkBusy}
            >
              {t('rules.bulkDelete')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearSelection}
              disabled={bulkBusy}
            >
              {t('rules.clearSelection')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              className={filterCls}
              placeholder={t('rules.filterPlaceholder')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <select
              className={selectCls}
              value={serviceFilter}
              onChange={(e) => setServiceFilter(e.target.value)}
            >
              <option value="">{t('rules.serviceFilterAll')}</option>
              {serviceOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <select
              className={selectCls}
              value={matchTypeFilter}
              onChange={(e) =>
                setMatchTypeFilter(e.target.value as ConditionItem['match_type'] | '')
              }
            >
              <option value="">{t('rules.matchTypeFilterAll')}</option>
              {MATCH_TYPES.map((mt) => (
                <option key={mt} value={mt}>
                  {t(MATCH_TYPE_LABEL_KEY[mt])}
                </option>
              ))}
            </select>
            <select
              className={selectCls}
              value={categoryFilter}
              onChange={(e) =>
                setCategoryFilter(e.target.value as ConditionCategory | '')
              }
            >
              <option value="">{t('rules.categoryFilterAll')}</option>
              {CATEGORIES.map((cat) => (
                <option key={cat} value={cat}>
                  {t(CATEGORY_LABEL_KEY[cat])}
                </option>
              ))}
            </select>
            {hasActiveFilter && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                {t('rules.clearFilters')}
              </Button>
            )}
            {!isDefaultSort && (
              <Button variant="ghost" size="sm" onClick={resetSort}>
                {t('rules.resetSort')}
              </Button>
            )}
            <span className="text-xs text-fg-subtle">
              {t('rules.countShown', { shown: visibleRules.length, total: rules.length })}
            </span>
          </div>
        ))}

      {vocabWarnings.length > 0 && (
        <div className="space-y-1 rounded-md border border-warning-line bg-warning-bg p-3 text-xs text-warning-fg">
          {vocabWarnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}

      <Table className="min-w-3xl">
        <Thead>
          <tr>
            <Th className="w-8">
              <input
                ref={selectAllRef}
                type="checkbox"
                aria-label={t('rules.selectAll')}
                checked={allVisibleSelected}
                onChange={toggleSelectAll}
              />
            </Th>
            <SortHeader
              label={t('rules.colName')}
              columnKey="name"
              activeKey={sortKey}
              dir={sortDir}
              onSort={toggleSort}
            />
            <SortHeader
              label={t('rules.colApp')}
              columnKey="app"
              activeKey={sortKey}
              dir={sortDir}
              onSort={toggleSort}
            />
            <Th className="text-center">{t('rules.colEnabled')}</Th>
            <Th>{t('rules.colType')}</Th>
            <Th>{t('rules.colCategory')}</Th>
            <Th>{t('rules.colValue')}</Th>
            <Th>{t('rules.colDirTemplate')}</Th>
          </tr>
        </Thead>
        <tbody className="divide-y divide-line">
          {rules.length === 0 && <TableEmpty colSpan={8}>{t('rules.empty')}</TableEmpty>}
          {rules.length > 0 && visibleRules.length === 0 && (
            <TableEmpty colSpan={8}>{t('rules.noMatch')}</TableEmpty>
          )}
          {visibleRules.map((r) => {
            const rows = conditionRows(r)
            return (
              <tr key={r.id} className={`bg-sunken/40 ${r.enabled ? '' : 'opacity-60'}`}>
                <td className="px-3 py-2 align-top">
                  <input
                    type="checkbox"
                    aria-label={t('rules.selectRow', { name: r.name })}
                    checked={selectedIds.has(r.id)}
                    onChange={() => toggleSelected(r.id)}
                  />
                </td>
                <td className="px-3 py-2 align-top font-medium">
                  <span
                    tabIndex={0}
                    role="button"
                    aria-label={t('rules.editRule', { name: r.name })}
                    onClick={() => openEdit(r)}
                    onKeyDown={(e) => handleNameKeyDown(e, r)}
                    className="rounded focus-visible:focus-ring"
                  >
                    {r.name}
                  </span>
                </td>
                <td className="px-3 py-2 align-top text-fg-muted">
                  {serviceLabel(r.app_name, r.app_type_scope)}
                </td>
                <td className="px-3 py-2 align-top text-center">
                  {r.enabled ? (
                    <Check
                      className="mx-auto size-4 text-success-fg"
                      aria-label={t('rules.colEnabled')}
                    />
                  ) : (
                    <span className="text-fg-faint" aria-hidden="true">
                      -
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 align-top text-xs">
                  <div className="flex flex-col gap-0.5">
                    {rows.map((cr) => (
                      <div key={cr.key}>{cr.type}</div>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 align-top text-xs">
                  <div className="flex flex-col gap-0.5">
                    {rows.map((cr) => (
                      <div key={cr.key} className="flex items-baseline gap-1.5">
                        {cr.join}
                        {cr.category}
                      </div>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 align-top text-xs">
                  <div className="flex flex-col gap-0.5">
                    {rows.map((cr) => (
                      <div key={cr.key}>{cr.value}</div>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2 align-top font-mono text-xs break-all text-fg-soft">
                  {r.dir_template}
                </td>
              </tr>
            )
          })}
        </tbody>
      </Table>

      {modalOpen && (
        <RuleModal
          initial={editing}
          onClose={() => setModalOpen(false)}
          onSaved={(saved) => {
            setVocabWarnings(saved.vocabulary_warnings ?? [])
            void load()
          }}
        />
      )}
    </div>
  )
}
