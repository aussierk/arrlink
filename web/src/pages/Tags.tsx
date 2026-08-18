import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  api,
  fmtTime,
  type AppItem,
  type ConditionCategory,
  type TagItem,
} from '../lib/api'

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
 * Tags (M6+): two views.
 *  - Tag repository: a curated, shared list of tags (ArrLink's own) that can
 *    be pushed to one or more *arr apps (which create the tag there).
 *  - App tags: the tag vocabulary imported from each app, with usage counts.
 */
export default function Tags() {
  const { t } = useTranslation()
  const [apps, setApps] = useState<AppItem[]>([])
  const [appId, setAppId] = useState<number | null>(null)
  const [tags, setTags] = useState<TagItem[]>([])
  const [imported, setImported] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [repo, setRepo] = useState<{ id: number; label: string }[]>([])
  const [newTag, setNewTag] = useState('')
  const [pushTargets, setPushTargets] = useState<Set<number>>(new Set())
  const [pushMsg, setPushMsg] = useState<string | null>(null)

  const loadApps = useCallback(async () => {
    try {
      const a = await api.listApps()
      setApps(a)
      setPushTargets(new Set(a.map((x) => x.id)))
      if (appId === null && a.length > 0) setAppId(a[0].id)
      if (appId !== null && !a.some((x) => x.id === appId)) setAppId(null)
    } catch (e) {
      setErr(String(e))
    }
  }, [appId])

  const loadRepo = useCallback(async () => {
    try {
      setRepo(await api.listTagRepository())
    } catch (e) {
      setErr(String(e))
    }
  }, [])

  const loadTags = useCallback(async () => {
    if (appId === null) return
    try {
      setTags(await api.listTags(appId))
    } catch (e) {
      setErr(String(e))
    }
  }, [appId])

  useEffect(() => {
    void loadApps()
  }, [loadApps])
  useEffect(() => {
    void loadRepo()
  }, [loadRepo])
  useEffect(() => {
    void loadTags()
  }, [loadTags])

  async function setTagCategory(tagId: number, category: ConditionCategory | null) {
    if (appId === null) return
    try {
      const updated = await api.setTagCategory(appId, tagId, category)
      setTags((prev) => prev.map((tg) => (tg.id === tagId ? updated : tg)))
    } catch (e) {
      setErr(String(e))
    }
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

  async function addRepoTag(e: React.FormEvent) {
    e.preventDefault()
    const label = newTag.trim()
    if (!label) return
    try {
      await api.addTagToRepository(label)
      setNewTag('')
      await loadRepo()
    } catch (e) {
      setErr(String(e))
    }
  }

  async function removeRepoTag(label: string) {
    try {
      await api.deleteTagFromRepository(label)
      await loadRepo()
    } catch (e) {
      setErr(String(e))
    }
  }

  async function pushRepoTag(label: string) {
    if (pushTargets.size === 0) {
      setErr(t('tags.repository.selectAppsErr'))
      return
    }
    setPushMsg(t('tags.repository.pushingOne', { label }))
    try {
      const r = await api.pushTag(label, [...pushTargets])
      setPushMsg(t('tags.repository.pushedOne', { label, ok: r.ok, failed: r.failed }))
      // re-import the affected apps so their tag lists refresh
      await loadApps()
    } catch (e) {
      setErr(String(e))
    }
  }

  async function pushAllRepo() {
    if (repo.length === 0 || pushTargets.size === 0) {
      setErr(t('tags.repository.nothingToPushErr'))
      return
    }
    setPushMsg(t('tags.repository.pushingAll', { count: repo.length }))
    let ok = 0
    let failed = 0
    for (const tag of repo) {
      const r = await api.pushTag(tag.label, [...pushTargets])
      ok += r.ok
      failed += r.failed
    }
    setPushMsg(t('tags.repository.pushedAll', { ok, failed }))
    await loadApps()
  }

  function toggleTarget(id: number) {
    setPushTargets((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-6">
      {err && (
        <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
          {err}
        </div>
      )}

      {/* ------------------------------ Tag repository --------------------- */}
      <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div>
          <h2 className="text-lg font-semibold">{t('tags.repository.title')}</h2>
          <p className="text-sm text-zinc-500">{t('tags.repository.subtitle')}</p>
        </div>

        <form onSubmit={addRepoTag} className="flex items-center gap-2">
          <input
            className="w-64 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            placeholder={t('tags.repository.placeholder')}
          />
          <button
            type="submit"
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
          >
            {t('tags.repository.addTag')}
          </button>
        </form>

        {apps.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
            <span>{t('tags.repository.pushTo')}</span>
            {apps.map((a) => (
              <label key={a.id} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={pushTargets.has(a.id)}
                  onChange={() => toggleTarget(a.id)}
                />
                {a.name}
              </label>
            ))}
            <button
              type="button"
              onClick={() => void pushAllRepo()}
              disabled={repo.length === 0}
              className="ml-auto rounded-md border border-indigo-500/50 px-3 py-1 text-xs text-indigo-300 hover:bg-indigo-950/40 disabled:opacity-50"
            >
              {t('tags.repository.pushAllTags')}
            </button>
          </div>
        )}

        {pushMsg && (
          <div className="rounded-md border border-indigo-900 bg-indigo-950/40 p-2 text-sm text-indigo-300">
            {pushMsg}
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {repo.length === 0 && (
            <span className="text-sm text-zinc-500">{t('tags.repository.empty')}</span>
          )}
          {repo.map((repoTag) => (
            <span
              key={repoTag.id}
              className="inline-flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm text-zinc-200"
            >
              <span className="font-mono text-xs">{repoTag.label}</span>
              <button
                onClick={() => void pushRepoTag(repoTag.label)}
                disabled={pushTargets.size === 0}
                className="text-xs text-indigo-300 hover:text-indigo-200 disabled:opacity-40"
              >
                {t('tags.repository.push')}
              </button>
              <button
                onClick={() => void removeRepoTag(repoTag.label)}
                className="text-xs text-red-400 hover:text-red-300"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      </div>

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
            onChange={(e) => setAppId(Number(e.target.value))}
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
            {tags.map((tag) => (
              <tr key={tag.id} className="bg-zinc-950/40">
                <td className="px-3 py-2 font-mono text-xs text-zinc-200">{tag.label}</td>
                <td className="px-3 py-2">
                  <select
                    className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
                    value={tag.category ?? ''}
                    onChange={(e) =>
                      void setTagCategory(
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
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
