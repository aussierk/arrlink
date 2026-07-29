import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type AppItem, type LinkItem } from '../lib/api'

/**
 * Links panel: browse, filter, remove, and repair the hardlinks ArrLink
 * maintains. Embedded on the Dashboard (not a standalone page).
 */
export default function LinksPanel() {
  const { t } = useTranslation()
  const [links, setLinks] = useState<LinkItem[]>([])
  const [apps, setApps] = useState<AppItem[]>([])
  const [appId, setAppId] = useState('')
  const [status, setStatus] = useState('active')
  const [err, setErr] = useState<string | null>(null)
  const [repairMsg, setRepairMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setLinks(
        await api.listLinks({
          app_id: appId ? Number(appId) : undefined,
          status: status || undefined,
        }),
      )
    } catch (e) {
      setErr(String(e))
    }
  }, [appId, status])

  useEffect(() => {
    api.listApps().then(setApps).catch(() => {})
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function repair() {
    setBusy(true)
    setRepairMsg(null)
    try {
      const r = await api.repairLinks()
      setRepairMsg(t('linksTable.repaired', { fixed: r.fixed, failed: r.failed }))
      await load()
    } catch (e) {
      setRepairMsg(t('linksTable.repairFailed', { error: String(e) }))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: number) {
    try {
      await api.deleteLink(id)
      await load()
    } catch (e) {
      setErr(String(e))
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
          value={appId}
          onChange={(e) => setAppId(e.target.value)}
        >
          <option value="">{t('linksTable.allApps')}</option>
          {apps.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="active">{t('linksTable.active')}</option>
          <option value="stale">{t('linksTable.stale')}</option>
          <option value="">{t('linksTable.all')}</option>
        </select>
        <button
          onClick={() => void repair()}
          disabled={busy}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {busy ? t('linksTable.repairing') : t('linksTable.repairMissing')}
        </button>
        <button
          onClick={() => void load()}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900"
        >
          {t('common.refresh')}
        </button>
      </div>

      {repairMsg && (
        <div className="rounded-md border border-indigo-900 bg-indigo-950/40 p-2 text-sm text-indigo-300">
          {repairMsg}
        </div>
      )}
      {err && (
        <div className="rounded-md border border-red-900 bg-red-950/40 p-2 text-sm text-red-300">
          {err}
        </div>
      )}

      <div className="max-h-96 overflow-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2">{t('linksTable.colApp')}</th>
              <th className="px-3 py-2">{t('linksTable.colRule')}</th>
              <th className="px-3 py-2">{t('linksTable.colSource')}</th>
              <th className="px-3 py-2">{t('linksTable.colLinkedTo')}</th>
              <th className="px-3 py-2">{t('linksTable.colStatus')}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {links.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-zinc-500">
                  {t('linksTable.empty')}
                </td>
              </tr>
            )}
            {links.map((l) => (
              <tr key={l.id} className="bg-zinc-950/40">
                <td className="px-3 py-2 text-zinc-300">
                  {l.app_type} · {l.app_name}
                </td>
                <td className="px-3 py-2 text-zinc-400">{l.rule_name}</td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                  {l.src_path}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-emerald-300">
                  {l.dst_path}
                </td>
                <td className="px-3 py-2 text-xs">
                  {l.status === 'active' ? (
                    <span className="text-emerald-400">{t('linksTable.active')}</span>
                  ) : (
                    <span className="text-amber-400">{l.status}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => void remove(l.id)}
                    className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-950/40"
                  >
                    {t('linksTable.remove')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
