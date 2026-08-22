import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useBlocker } from 'react-router-dom'
import {
  api,
  fmtTime,
  type AppItem,
  type ConditionCategory,
  type TagItem,
} from '../lib/api'
import { useBeforeUnloadGuard } from '../lib/unsavedGuard'

const CLASSIFIABLE_CATEGORIES: ConditionCategory[] = [
  'genre',
  'certification',
  'collection',
  'quality',
  'language',
  'user',
  'custom',
]

/**
 * Tags: the tag vocabulary imported from each app, with usage counts and
 * per-tag category classification.
 */
export default function Tags() {
  const { t } = useTranslation()
  const [apps, setApps] = useState<AppItem[]>([])
  const [appId, setAppId] = useState<number | null>(null)
  const [tags, setTags] = useState<TagItem[]>([])
  const [imported, setImported] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Category edits are staged here, not saved on select — the row's
  // dropdown shows the pending value if there is one, else the saved
  // tag.category. Cleared on save, discard, or a full tag-list reload.
  const [pendingEdits, setPendingEdits] = useState<
    Record<number, ConditionCategory | null>
  >({})
  const [saving, setSaving] = useState(false)
  const hasPending = Object.keys(pendingEdits).length > 0

  const loadApps = useCallback(async () => {
    try {
      const a = await api.listApps()
      setApps(a)
      if (appId === null && a.length > 0) setAppId(a[0].id)
      if (appId !== null && !a.some((x) => x.id === appId)) setAppId(null)
    } catch (e) {
      setErr(String(e))
    }
  }, [appId])

  const loadTags = useCallback(async () => {
    if (appId === null) return
    try {
      setTags(await api.listTags(appId))
      setPendingEdits({})
    } catch (e) {
      setErr(String(e))
    }
  }, [appId])

  useEffect(() => {
    void loadApps()
  }, [loadApps])
  useEffect(() => {
    void loadTags()
  }, [loadTags])

  const saveTagEdits = useCallback(async (): Promise<boolean> => {
    const ids = Object.keys(pendingEdits).map(Number)
    if (ids.length === 0 || appId === null) return true
    setSaving(true)
    try {
      const results = await Promise.all(
        ids.map((id) => api.setTagCategory(appId, id, pendingEdits[id])),
      )
      const byId = new Map(results.map((r) => [r.id, r]))
      setTags((prev) => prev.map((tg) => byId.get(tg.id) ?? tg))
      setPendingEdits({})
      return true
    } catch (e) {
      setErr(String(e))
      return false
    } finally {
      setSaving(false)
    }
  }, [pendingEdits, appId])

  // Blocks any in-app navigation away from this page (sidebar, SettingsNav,
  // browser back/forward) while there's something unsaved — react-router's
  // own mechanism, works for every nav surface with no per-surface wiring.
  // beforeunload (tab close/refresh/URL bar) isn't a router navigation, so
  // it needs the separate hook below.
  const blocker = useBlocker(hasPending)
  useEffect(() => {
    if (blocker.state !== 'blocked') return
    const shouldSave = window.confirm(
      'You have unsaved tag classification changes. Save them before leaving this page?',
    )
    if (!shouldSave) {
      blocker.proceed()
      return
    }
    void saveTagEdits().then((ok) => {
      if (ok) blocker.proceed()
      else blocker.reset() // save failed -- stay so the error is visible
    })
  }, [blocker, saveTagEdits])
  useBeforeUnloadGuard(hasPending)

  function stageTagCategory(tagId: number, category: ConditionCategory | null) {
    const tag = tags.find((tg) => tg.id === tagId)
    setPendingEdits((prev) => {
      const next = { ...prev }
      if (tag && category === tag.category) {
        delete next[tagId] // back to the saved value -> no longer pending
      } else {
        next[tagId] = category
      }
      return next
    })
  }

  async function switchApp(nextId: number) {
    if (hasPending) {
      const shouldSave = window.confirm(
        'You have unsaved tag classification changes. Save them before switching services?',
      )
      if (shouldSave) {
        const ok = await saveTagEdits()
        if (!ok) return // stay put so the error (and the edits) are still visible
      } else {
        setPendingEdits({})
      }
    }
    setAppId(nextId)
  }

  async function doImport() {
    if (appId === null) return
    setBusy(true)
    setErr(null)
    setImported(null)
    try {
      const r = await api.importTags(appId)
      setImported(t('tags.appTags.imported', { count: r.imported }))
      await loadTags()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      {err && (
        <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
          {err}
        </div>
      )}

      {/* ------------------------------ App tags --------------------------- */}
      <div className="flex items-end gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('tags.appTags.title')}</h2>
          <p className="text-sm text-zinc-500">{t('tags.appTags.subtitle')}</p>
        </div>
        {apps.length > 0 && (
          <select
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
            value={appId ?? ''}
            onChange={(e) => void switchApp(Number(e.target.value))}
          >
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.type})
              </option>
            ))}
          </select>
        )}
        <button
          onClick={() => void doImport()}
          disabled={appId === null || busy}
          className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {busy ? t('tags.appTags.importing') : t('tags.appTags.importTags')}
        </button>
        <button
          onClick={() => void saveTagEdits()}
          disabled={!hasPending || saving}
          className="ml-auto rounded-md border border-amber-500/50 px-4 py-1.5 text-sm font-medium text-amber-300 hover:bg-amber-950/40 disabled:opacity-40"
        >
          {saving
            ? t('tags.appTags.saving')
            : t('tags.appTags.saveChanges', { count: Object.keys(pendingEdits).length })}
        </button>
      </div>

      {imported && (
        <div className="rounded-md border border-emerald-900 bg-emerald-950/40 p-3 text-sm text-emerald-300">
          {imported}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2">{t('tags.appTags.colTag')}</th>
              <th className="px-3 py-2">{t('tags.appTags.colCategory')}</th>
              <th className="px-3 py-2">{t('tags.appTags.colInUse')}</th>
              <th className="px-3 py-2">{t('tags.appTags.colRules')}</th>
              <th className="px-3 py-2">{t('tags.appTags.colImported')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {tags.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-zinc-500">
                  {appId === null
                    ? t('tags.appTags.connectFirst')
                    : t('tags.appTags.emptyImport')}
                </td>
              </tr>
            )}
            {tags.map((tag) => {
              const isPending = tag.id in pendingEdits
              const shown = isPending ? pendingEdits[tag.id] : tag.category
              return (
                <tr key={tag.id} className="bg-zinc-950/40">
                  <td className="px-3 py-2 font-mono text-xs text-zinc-200">
                    {tag.label}
                  </td>
                  <td className="px-3 py-2">
                    <select
                      className={`rounded-md border bg-zinc-950 px-2 py-1 text-xs text-zinc-200 ${
                        isPending ? 'border-amber-500' : 'border-zinc-700'
                      }`}
                      value={shown ?? ''}
                      onChange={(e) =>
                        stageTagCategory(
                          tag.id,
                          (e.target.value || null) as ConditionCategory | null,
                        )
                      }
                    >
                      <option value="">{t('tags.appTags.unclassified')}</option>
                      {CLASSIFIABLE_CATEGORIES.map((cat) => (
                        <option key={cat} value={cat}>
                          {t(`ruleModal.categoryLabel.${cat}`)}
                        </option>
                      ))}
                    </select>
                    {isPending && (
                      <span className="ml-1.5 text-[11px] text-amber-400">
                        {t('tags.appTags.unsaved')}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-zinc-400">{tag.count}</td>
                  <td className="px-3 py-2 text-zinc-400">
                    {tag.rule_count > 0 ? (
                      <span className="text-indigo-300">{tag.rule_count}</span>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-zinc-500">{fmtTime(tag.imported_at)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
