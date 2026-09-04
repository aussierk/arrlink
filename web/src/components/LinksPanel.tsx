import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type AppItem, type LinkItem } from '../lib/api'
import Button from './ui/Button'
import { useToast } from '../lib/useToast'

/**
 * Links panel: browse, filter, remove, and repair the hardlinks ArrLink
 * maintains. Embedded on the Dashboard (not a standalone page).
 */
const PAGE_SIZE = 100

export default function LinksPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const [links, setLinks] = useState<LinkItem[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [apps, setApps] = useState<AppItem[]>([])
  const [appId, setAppId] = useState('')
  const [status, setStatus] = useState('active')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await api.listLinks({
        app_id: appId ? Number(appId) : undefined,
        status: status || undefined,
        limit: PAGE_SIZE,
        offset,
      })
      setLinks(r.items)
      setTotal(r.total)
    } catch (e) {
      toast.error(String(e))
    }
  }, [appId, status, offset, toast])

  useEffect(() => {
    api
      .listApps()
      .then(setApps)
      .catch(() => {})
  }, [])

  useEffect(() => {
    setOffset(0)
  }, [appId, status])

  useEffect(() => {
    void load()
  }, [load])

  async function repair() {
    setBusy(true)
    try {
      const r = await api.repairLinks()
      toast.success(t('linksTable.repaired', { fixed: r.fixed, failed: r.failed }))
      await load()
    } catch (e) {
      toast.error(t('linksTable.repairFailed', { error: String(e) }))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: number) {
    try {
      await api.deleteLink(id)
      await load()
    } catch (e) {
      toast.error(String(e))
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="rounded-md border border-line-strong bg-sunken px-2 py-1.5 text-sm text-fg"
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
          className="rounded-md border border-line-strong bg-sunken px-2 py-1.5 text-sm text-fg"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="active">{t('linksTable.active')}</option>
          <option value="stale">{t('linksTable.stale')}</option>
          <option value="">{t('linksTable.all')}</option>
        </select>
        <Button onClick={() => void repair()} disabled={busy} loading={busy}>
          {busy ? t('linksTable.repairing') : t('linksTable.repairMissing')}
        </Button>
        <Button variant="secondary" onClick={() => void load()}>
          {t('common.refresh')}
        </Button>
      </div>

      <div className="max-h-96 overflow-auto rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface text-left text-xs uppercase tracking-wide text-fg-subtle">
            <tr>
              <th scope="col" className="px-3 py-2">
                {t('linksTable.colApp')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('linksTable.colRule')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('linksTable.colSource')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('linksTable.colLinkedTo')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('linksTable.colStatus')}
              </th>
              <th scope="col" className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {links.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-fg-subtle">
                  {t('linksTable.empty')}
                </td>
              </tr>
            )}
            {links.map((l) => (
              <tr key={l.id} className="bg-sunken/40">
                <td className="px-3 py-2 text-fg-soft">
                  {l.app_type} · {l.app_name}
                </td>
                <td className="px-3 py-2 text-fg-muted">{l.rule_name}</td>
                <td className="px-3 py-2 font-mono text-xs text-fg-subtle">
                  {l.src_path}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-success-fg">
                  {l.dst_path}
                </td>
                <td className="px-3 py-2 text-xs">
                  {l.status === 'active' ? (
                    <span className="text-success-fg">{t('linksTable.active')}</span>
                  ) : (
                    <span className="text-warning-fg">{l.status}</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    onClick={() => void remove(l.id)}
                  >
                    {t('linksTable.remove')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between text-xs text-fg-subtle">
          <span>
            {t('linksTable.showingRange', {
              from: offset + 1,
              to: Math.min(offset + PAGE_SIZE, total),
              total,
            })}
          </span>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              disabled={offset === 0}
            >
              {t('common.prev')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setOffset(offset + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total}
            >
              {t('common.next')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
