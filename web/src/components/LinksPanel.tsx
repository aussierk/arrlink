import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { api, type AppItem, type LinkItem } from '../lib/api'
import Button from './ui/Button'
import { TableEmpty, Th, Thead } from './ui/Table'
import { useAsyncLoad } from '../lib/useAsyncLoad'
import { useToast } from '../lib/useToast'
import { selectCls } from '../lib/ui'

/**
 * Links panel: browse, filter, remove, and repair the hardlinks ArrLink
 * maintains. Embedded on the Dashboard (not a standalone page).
 */
const PAGE_SIZE = 100

const STATUSES = ['active', 'stale', 'missing', ''] as const

/** `?links=<status>` if it's a valid filter value, else null. */
function readStatusParam(params: URLSearchParams): string | null {
  const s = params.get('links')
  return s !== null && (STATUSES as readonly string[]).includes(s) ? s : null
}

export default function LinksPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const [params] = useSearchParams()
  const [links, setLinks] = useState<LinkItem[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [apps, setApps] = useState<AppItem[]>([])
  const [appId, setAppId] = useState('')
  const [status, setStatus] = useState(readStatusParam(params) ?? 'active')
  const [busy, setBusy] = useState(false)

  // The dashboard's link-health card deep-links here via ?links=<status>.
  // The panel is already mounted (it lives on the Dashboard), so a plain
  // param change won't re-run the initializer above -- sync it here. Manual
  // <select> edits don't navigate, so this doesn't fight them.
  useEffect(() => {
    const s = readStatusParam(params)
    if (s !== null) setStatus(s)
  }, [params])

  const load = useAsyncLoad(async () => {
    const r = await api.listLinks({
      app_id: appId ? Number(appId) : undefined,
      status: status || undefined,
      limit: PAGE_SIZE,
      offset,
    })
    setLinks(r.items)
    setTotal(r.total)
  }, [appId, status, offset])

  useEffect(() => {
    api
      .listApps()
      .then(setApps)
      .catch(() => {})
  }, [])

  useEffect(() => {
    setOffset(0)
  }, [appId, status])

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
          className={selectCls}
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
          className={selectCls}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="active">{t('linksTable.active')}</option>
          <option value="stale">{t('linksTable.stale')}</option>
          <option value="missing">{t('linksTable.missing')}</option>
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
        <table className="w-full min-w-4xl text-sm">
          <Thead className="sticky top-0">
            <tr>
              <Th>{t('linksTable.colApp')}</Th>
              <Th>{t('linksTable.colRule')}</Th>
              <Th>{t('linksTable.colSource')}</Th>
              <Th>{t('linksTable.colLinkedTo')}</Th>
              <Th>{t('linksTable.colStatus')}</Th>
              <Th />
            </tr>
          </Thead>
          <tbody className="divide-y divide-line">
            {links.length === 0 && (
              <TableEmpty colSpan={6}>{t('linksTable.empty')}</TableEmpty>
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
                  ) : l.status === 'stale' ? (
                    <span className="text-warning-fg">{t('linksTable.stale')}</span>
                  ) : l.status === 'missing' ? (
                    <span className="text-danger-fg">{t('linksTable.missing')}</span>
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
