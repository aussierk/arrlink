import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import PreviewPanel from '../components/PreviewPanel'
import RuleModal from '../components/RuleModal'
import {
  api,
  type AppItem,
  type ConditionItem,
  type RuleItem,
} from '../lib/api'
import { REGEX_PICKS } from '../lib/tagOptions'
import i18n from '../i18n'

const CATEGORY_LABEL_KEY: Record<string, string> = {
  user: 'rules.categoryLabel.user',
  genre: 'rules.categoryLabel.genre',
  language: 'rules.categoryLabel.language',
  quality: 'rules.categoryLabel.quality',
  certification: 'rules.categoryLabel.certification',
  collection: 'rules.categoryLabel.collection',
  custom: 'rules.categoryLabel.custom',
  legacy: 'rules.categoryLabel.legacy',
}

/** Render one condition readably: exact as-is, list as count+chips, regex as a
 * friendly label when it's a known pattern (else a short mono snippet).
 * Not a component (used inline in a table cell builder), so it reads
 * translations off the i18next singleton instead of the useTranslation hook. */
function conditionValue(c: ConditionItem) {
  const t = i18n.t
  if (c.match_type === 'list') {
    const tags = c.match_value.split(',').map((s) => s.trim()).filter(Boolean)
    const shown = tags.slice(0, 3)
    const more = tags.length - shown.length
    return (
      <span className="flex flex-wrap items-center gap-1">
        {shown.map((tag) => (
          <span
            key={tag}
            className="rounded-full border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-300"
          >
            {tag}
          </span>
        ))}
        {more > 0 && (
          <span className="text-[11px] text-zinc-500">{t('rules.matchMore', { count: more })}</span>
        )}
      </span>
    )
  }
  if (c.match_type === 'regex') {
    const pick = REGEX_PICKS.find((p) => p.pattern === c.match_value)
    return (
      <span className={pick ? '' : 'break-all font-mono text-[11px]'}>
        {pick ? pick.label : c.match_value}
      </span>
    )
  }
  return <span>{c.match_value}</span>
}

/** Render a rule's whole AND/OR condition chain compactly for the table. */
function matchCell(r: RuleItem) {
  const t = i18n.t
  return (
    <span className="flex flex-wrap items-center gap-1 text-xs">
      {r.conditions.map((c, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && (
            <span className="rounded bg-zinc-800 px-1 text-[10px] font-semibold text-indigo-300">
              {c.join === 'AND' ? t('conditions.joinAnd') : t('conditions.joinOr')}
            </span>
          )}
          <span className="text-zinc-500">
            {CATEGORY_LABEL_KEY[c.category] ? t(CATEGORY_LABEL_KEY[c.category]) : c.category} ·
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
  const [rules, setRules] = useState<RuleItem[]>([])
  const [apps, setApps] = useState<AppItem[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<RuleItem | null>(null)
  const [previewFor, setPreviewFor] = useState<RuleItem | null>(null)
  const [vocabWarnings, setVocabWarnings] = useState<string[]>([])

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
      setErr(String(e))
    }
  }, [])

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
      .listLinks({ rule_id: r.id, status: 'active' })
      .catch(() => [] as { id: number }[])
    const msg =
      links.length > 0
        ? t('rules.deleteConfirmWithLinks', { name: r.name, count: links.length })
        : t('rules.deleteConfirm', { name: r.name })
    if (!confirm(msg)) return
    try {
      await api.deleteRule(r.id)
      setOk(t('rules.deletedMsg', { name: r.name }))
      await load()
    } catch (e) {
      setErr(String(e))
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{t('rules.title')}</h2>
          <p className="text-sm text-zinc-500">{t('rules.subtitle')}</p>
        </div>
        <button
          onClick={openNew}
          className="shrink-0 whitespace-nowrap rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
        >
          {t('rules.addRule')}
        </button>
      </div>

      {err && (
        <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
          {err}
        </div>
      )}
      {ok && (
        <div className="rounded-md border border-emerald-900 bg-emerald-950/40 p-3 text-sm text-emerald-300">
          {ok}
        </div>
      )}
      {vocabWarnings.length > 0 && (
        <div className="space-y-1 rounded-md border border-amber-900/60 bg-amber-950/20 p-3 text-xs text-amber-300">
          {vocabWarnings.map((w, i) => (
            <p key={i}>{w}</p>
          ))}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2">{t('rules.colName')}</th>
              <th className="px-3 py-2">{t('rules.colApp')}</th>
              <th className="px-3 py-2">{t('rules.colMatch')}</th>
              <th className="px-3 py-2">{t('rules.colDirTemplate')}</th>
              <th className="px-3 py-2">{t('rules.colFilename')}</th>
              <th className="px-3 py-2">{t('rules.colFlags')}</th>
              <th className="px-3 py-2">{t('rules.colPreview')}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {rules.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-zinc-500">
                  {t('rules.empty')}
                </td>
              </tr>
            )}
            {rules.map((r) => (
              <tr key={r.id} className="bg-zinc-950/40">
                <td className="px-3 py-2 font-medium">
                  {r.name}
                  {!r.enabled && (
                    <span className="ml-2 text-xs text-zinc-500">{t('rules.off')}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-zinc-400">
                  {r.app_name ??
                    (r.app_type_scope === 'radarr'
                      ? t('ruleModal.allRadarr')
                      : r.app_type_scope === 'sonarr'
                        ? t('ruleModal.allSonarr')
                        : t('rules.any'))}
                </td>
                <td className="px-3 py-2 text-xs">
                  {matchCell(r)}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-300">
                  {r.dir_template}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                  {r.filename_template ?? t('rules.sourceFilename')}
                </td>
                <td className="px-3 py-2 text-xs text-zinc-400">
                  {t('rules.priorityLabel', { priority: r.priority })}
                  {r.unlink_on_mismatch ? t('rules.unlinkSuffix') : ''}
                </td>
                <td className="px-3 py-2">
                  <button
                    onClick={() =>
                      setPreviewFor(previewFor?.id === r.id ? null : r)
                    }
                    className="rounded px-2 py-1 text-xs text-indigo-300 hover:bg-indigo-950/40"
                  >
                    {previewFor?.id === r.id ? t('rules.hide') : t('rules.preview')}
                  </button>
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => openEdit(r)}
                      className="rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                    >
                      {t('rules.edit')}
                    </button>
                    <button
                      onClick={() => void remove(r)}
                      className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-950/40"
                    >
                      {t('rules.delete')}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {previewFor && (
              <tr className="bg-zinc-900/40">
                <td colSpan={8} className="px-3 py-3">
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
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

      <p className="text-xs text-zinc-600">
        {t('rules.footer')}
      </p>

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
