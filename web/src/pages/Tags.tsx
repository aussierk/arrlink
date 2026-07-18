import { useCallback, useEffect, useState } from 'react'
import { api, fmtTime, type AppItem, type TagItem } from '../lib/api'

export default function Tags() {
  const [apps, setApps] = useState<AppItem[]>([])
  const [appId, setAppId] = useState<number | null>(null)
  const [tags, setTags] = useState<TagItem[]>([])
  const [imported, setImported] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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

  async function doImport() {
    if (appId === null) return
    setBusy(true)
    setErr(null)
    setImported(null)
    try {
      const r = await api.importTags(appId)
      setImported(`Imported ${r.imported} tag(s)`)
      await loadTags()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end gap-3">
        <div>
          <h2 className="text-xl font-semibold">Tags</h2>
          <p className="text-sm text-zinc-500">
            Tag vocabulary imported from each app, with usage counts.
          </p>
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
          {busy ? 'Importing…' : 'Import tags'}
        </button>
      </div>

      {err && (
        <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
          {err}
        </div>
      )}
      {imported && (
        <div className="rounded-md border border-emerald-900 bg-emerald-950/40 p-3 text-sm text-emerald-300">
          {imported}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2">Tag</th>
              <th className="px-3 py-2">In use (app)</th>
              <th className="px-3 py-2">Rules</th>
              <th className="px-3 py-2">Imported</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {tags.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-zinc-500">
                  {appId === null
                    ? 'Connect an app first.'
                    : 'No tags imported yet — click Import tags.'}
                </td>
              </tr>
            )}
            {tags.map((t) => (
              <tr key={t.id} className="bg-zinc-950/40">
                <td className="px-3 py-2 font-mono text-xs text-zinc-200">
                  {t.label}
                </td>
                <td className="px-3 py-2 text-zinc-400">{t.count}</td>
                <td className="px-3 py-2 text-zinc-400">
                  {t.rule_count > 0 ? (
                    <span className="text-indigo-300">{t.rule_count}</span>
                  ) : (
                    <span className="text-zinc-600">—</span>
                  )}
                </td>
                <td className="px-3 py-2 text-zinc-500">{fmtTime(t.imported_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
