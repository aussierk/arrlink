import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, EyeOff, Pencil, Trash2 } from 'lucide-react'
import PreviewPanel from '../components/PreviewPanel'
import RuleModal from '../components/RuleModal'
import Button from '../components/ui/Button'
import SortHeader from '../components/ui/SortHeader'
import { useConfirm } from '../lib/useConfirm'
import { useSort } from '../lib/useSort'
import { useToast } from '../lib/useToast'
import { api, type AppItem, type ConditionItem, type RuleItem } from '../lib/api'
import { REGEX_PICKS } from '../lib/tagOptions'
import i18n from '../i18n'

const filterCls =
  'w-56 rounded-md border border-line-strong bg-sunken px-2 py-1.5 text-sm text-fg outline-none focus:border-ring focus-visible:focus-ring'

const RULE_SORT: Record<string, (r: RuleItem) => string | number> = {
  name: (r) => r.name.toLowerCase(),
  app: (r) => r.app_name ?? r.app_type_scope ?? '',
  priority: (r) => r.priority,
}

/** Lowercased text blob for the filter box to match against. */
function ruleHaystack(r: RuleItem): string {
  return [
    r.name,
    r.app_name ?? r.app_type_scope ?? '',
    r.dir_template,
    r.filename_template ?? '',
    ...r.conditions.flatMap((c) => [c.category, c.match_value]),
  ]
    .join(' ')
    .toLowerCase()
}

const CATEGORY_LABEL_KEY: Record<string, string> = {
  user: 'rules.categoryLabel.user',
  genre: 'rules.categoryLabel.genre',
  language: 'rules.categoryLabel.language',
  quality: 'rules.categoryLabel.quality',
  certification: 'rules.categoryLabel.certification',
  collection: 'rules.categoryLabel.collection',
  custom: 'rules.categoryLabel.custom',
}

/** Render one condition readably: exact as-is, list as count+chips, regex as a
 * friendly label when it's a known pattern (else a short mono snippet).
 * Not a component (used inline in a table cell builder), so it reads
 * translations off the i18next singleton instead of the useTranslation hook. */
function conditionValue(c: ConditionItem) {
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

/** One condition per line: [JOIN] Category  values. Kept plain-text (no pills)
 * so a dense table row stays one predictable height per condition. */
function matchCell(r: RuleItem) {
  const t = i18n.t
  return (
    <span className="flex flex-col gap-0.5 text-xs">
      {r.conditions.map((c, i) => (
        <span key={i} className="flex items-baseline gap-1.5">
          {i > 0 && (
            <span className="rounded bg-fill px-1 text-[10px] font-semibold text-accent">
              {c.join === 'AND' ? t('conditions.joinAnd') : t('conditions.joinOr')}
            </span>
          )}
          <span className="whitespace-nowrap text-fg-subtle">
            {CATEGORY_LABEL_KEY[c.category]
              ? t(CATEGORY_LABEL_KEY[c.category])
              : c.category}
          </span>
          {conditionValue(c)}
        </span>
      ))}
    </span>
  )
}

/**
 * Rules: the single place to build and edit rules. "Add rule" opens the
 * rule modal, which includes a "start from a preset" quick-start. Each row can
 * be edited, previewed, or deleted.
 */
export default function Rules() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const toast = useToast()
  const [rules, setRules] = useState<RuleItem[]>([])
  const [apps, setApps] = useState<AppItem[]>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<RuleItem | null>(null)
  const [previewFor, setPreviewFor] = useState<RuleItem | null>(null)
  const [vocabWarnings, setVocabWarnings] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const {
    sorted: sortedRules,
    sortKey,
    sortDir,
    toggleSort,
  } = useSort(rules, RULE_SORT, 'priority')
  const q = filter.trim().toLowerCase()
  const visibleRules = q
    ? sortedRules.filter((r) => ruleHaystack(r).includes(q))
    : sortedRules

  const previewAppId = (r: { app_scope: number | null; app_type_scope: string | null }) =>
    r.app_scope ??
    apps.find((a) => a.type === r.app_type_scope)?.id ??
    apps[0]?.id ??
    null

  const load = useCallback(async () => {
    try {
      const [r, a] = await Promise.all([api.listRules(), api.listApps()])
      setRules(r)
      setApps(a)
    } catch (e) {
      toast.error(String(e))
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  function openNew() {
    setEditing(null)
    setModalOpen(true)
  }

  function openEdit(r: RuleItem) {
    setEditing(r)
    setModalOpen(true)
  }

  async function remove(r: RuleItem) {
    const links = await api
      .listLinks({ rule_id: r.id, status: 'active', limit: 1 })
      .catch(() => ({ total: 0 }))
    const message =
      links.total > 0
        ? t('rules.deleteConfirmWithLinks', { name: r.name, count: links.total })
        : t('rules.deleteConfirm', { name: r.name })
    if (!(await confirm({ title: t('rules.deleteTitle'), message, variant: 'danger' })))
      return
    try {
      await api.deleteRule(r.id)
      toast.success(t('rules.deletedMsg', { name: r.name }))
      await load()
    } catch (e) {
      toast.error(String(e))
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{t('rules.title')}</h2>
          <p className="text-sm text-fg-subtle">{t('rules.subtitle')}</p>
        </div>
        <Button onClick={openNew} className="shrink-0 whitespace-nowrap">
          {t('rules.addRule')}
        </Button>
      </div>

      {rules.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            className={filterCls}
            placeholder={t('rules.filterPlaceholder')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="text-xs text-fg-subtle">
            {t('rules.countShown', { shown: visibleRules.length, total: rules.length })}
          </span>
        </div>
      )}

      {vocabWarnings.length > 0 && (
        <div className="space-y-1 rounded-md border border-warning-line bg-warning-bg p-3 text-xs text-warning-fg">
          {vocabWarnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-3xl text-sm">
          <thead className="bg-surface text-left text-xs uppercase tracking-wide text-fg-subtle">
            <tr>
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
              <th scope="col" className="px-3 py-2">
                {t('rules.colMatch')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('rules.colDirTemplate')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('rules.colFilename')}
              </th>
              <SortHeader
                label={t('rules.colFlags')}
                columnKey="priority"
                activeKey={sortKey}
                dir={sortDir}
                onSort={toggleSort}
              />
              <th scope="col" className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rules.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-fg-subtle">
                  {t('rules.empty')}
                </td>
              </tr>
            )}
            {rules.length > 0 && visibleRules.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-fg-subtle">
                  {t('rules.noMatch', { query: filter.trim() })}
                </td>
              </tr>
            )}
            {visibleRules.map((r) => (
              <tr key={r.id} className="bg-sunken/40">
                <td className="px-3 py-2 font-medium">
                  {r.name}
                  {!r.enabled && (
                    <span className="ml-2 text-xs text-fg-subtle">{t('rules.off')}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-fg-muted">
                  {r.app_name ??
                    (r.app_type_scope === 'radarr'
                      ? t('ruleModal.allRadarr')
                      : r.app_type_scope === 'sonarr'
                        ? t('ruleModal.allSonarr')
                        : t('rules.any'))}
                </td>
                <td className="px-3 py-2 align-top text-xs">{matchCell(r)}</td>
                <td className="px-3 py-2 align-top font-mono text-xs break-all text-fg-soft">
                  {r.dir_template}
                </td>
                <td className="px-3 py-2 align-top font-mono text-xs break-all text-fg-subtle">
                  {r.filename_template ?? t('rules.sourceFilename')}
                </td>
                <td className="px-3 py-2 align-top text-xs whitespace-nowrap text-fg-muted">
                  {t('rules.priorityLabel', { priority: r.priority })}
                  {r.unlink_on_mismatch ? t('rules.unlinkSuffix') : ''}
                </td>
                <td className="px-3 py-2 align-top">
                  <div className="flex items-center justify-end gap-0.5">
                    <button
                      type="button"
                      onClick={() => setPreviewFor(previewFor?.id === r.id ? null : r)}
                      aria-label={t('rules.previewRule', { name: r.name })}
                      title={
                        previewFor?.id === r.id ? t('rules.hide') : t('rules.preview')
                      }
                      className={`rounded p-1.5 transition-colors focus-visible:focus-ring ${
                        previewFor?.id === r.id
                          ? 'bg-accent-bg text-accent'
                          : 'text-fg-subtle hover:bg-fill hover:text-fg'
                      }`}
                    >
                      {previewFor?.id === r.id ? (
                        <EyeOff className="size-4" />
                      ) : (
                        <Eye className="size-4" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(r)}
                      aria-label={t('rules.editRule', { name: r.name })}
                      title={t('rules.edit')}
                      className="rounded p-1.5 text-fg-subtle transition-colors hover:bg-fill hover:text-fg focus-visible:focus-ring"
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void remove(r)}
                      aria-label={t('rules.deleteRule', { name: r.name })}
                      title={t('rules.delete')}
                      className="rounded p-1.5 text-fg-subtle transition-colors hover:bg-danger-bg hover:text-danger-fg focus-visible:focus-ring"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {previewFor && (
              <tr className="bg-surface/40">
                <td colSpan={7} className="px-3 py-3">
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                    {t('rules.previewHeading', { name: previewFor.name })}
                  </h4>
                  <PreviewPanel
                    rule={{
                      name: previewFor.name,
                      app_scope: previewFor.app_scope,
                      app_type_scope: previewFor.app_type_scope,
                      conditions: previewFor.conditions,
                      dir_template: previewFor.dir_template,
                      filename_template: previewFor.filename_template,
                      enabled: previewFor.enabled,
                      unlink_on_mismatch: previewFor.unlink_on_mismatch,
                      priority: previewFor.priority,
                    }}
                    appId={previewAppId(previewFor)}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-fg-faint">{t('rules.footer')}</p>

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
