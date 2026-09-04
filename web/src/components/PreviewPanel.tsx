import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, getDisplayTimezone, type RuleInput } from '../lib/api'

type PreviewData = {
  app_id: number
  app_name: string
  source: 'snapshot' | 'live'
  snapshot_at: number | null
  total: number
  sample: { item_title: string; src_path: string; dst_path: string }[]
  errors: { item_title: string; src_path: string; error: string }[]
}

/**
 * Live dry-run preview for a rule against one app. No links are created;
 * it shows exactly which files would land where (plus any template errors).
 */
export default function PreviewPanel({
  rule,
  appId,
}: {
  rule: RuleInput
  appId: number | null
}) {
  const { t } = useTranslation()
  const [data, setData] = useState<PreviewData | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [stamp, setStamp] = useState(0)

  async function run(forceLive = false) {
    if (appId === null) return
    setBusy(true)
    setErr(null)
    try {
      const r = await api.previewRule(rule, appId, { live: forceLive })
      setData(r)
      setStamp(Date.now())
    } catch (e) {
      setErr(String(e))
      setData(null)
    } finally {
      setBusy(false)
    }
  }

  // The parent's "Run Preview" button reveals this panel — run once
  // immediately on mount so opening it is a single click, not two.
  useEffect(() => {
    void run()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (appId === null) {
    return <p className="text-xs text-fg-faint">{t('previewPanel.pickApp')}</p>
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void run()}
          disabled={busy}
          className="rounded-md border border-ring/50 px-3 py-1 text-xs text-accent hover:bg-accent-bg disabled:opacity-50"
        >
          {busy
            ? t('previewPanel.previewing')
            : data
              ? t('previewPanel.rerun')
              : t('previewPanel.preview')}
        </button>
        <button
          onClick={() => void run(true)}
          disabled={busy}
          className="rounded-md border border-line-strong px-3 py-1 text-xs text-fg-soft hover:bg-surface disabled:opacity-50"
        >
          {busy ? t('previewPanel.refreshing') : t('previewPanel.refreshFromApp')}
        </button>
        {data && (
          <span className="text-xs text-fg-subtle">
            {t('previewPanel.filesWouldLink', {
              count: data.total,
              time: new Date(stamp).toLocaleTimeString(undefined, {
                timeZone: getDisplayTimezone(),
              }),
            })}
            {' · '}
            {data.source === 'snapshot'
              ? t('previewPanel.fromSnapshot', {
                  time: data.snapshot_at
                    ? new Date(data.snapshot_at * 1000).toLocaleTimeString(undefined, {
                        timeZone: getDisplayTimezone(),
                      })
                    : '—',
                })
              : t('previewPanel.fromLive')}
          </span>
        )}
      </div>
      {err && <p className="text-xs text-danger-fg">{err}</p>}
      {data?.sample && data.sample.length > 0 && (
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="w-full text-xs">
            <thead className="bg-surface text-left text-fg-subtle">
              <tr>
                <th scope="col" className="px-2 py-1">
                  {t('previewPanel.item')}
                </th>
                <th scope="col" className="px-2 py-1">
                  {t('previewPanel.source')}
                </th>
                <th scope="col" className="px-2 py-1">
                  {t('previewPanel.wouldLinkTo')}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {data.sample.map((s, i) => (
                <tr key={i}>
                  <td className="px-2 py-1 text-fg-soft">{s.item_title}</td>
                  <td className="px-2 py-1 font-mono text-fg-subtle">{s.src_path}</td>
                  <td className="px-2 py-1 font-mono text-success-fg">{s.dst_path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data?.errors && data.errors.length > 0 && (
        <div className="rounded-md border border-warning-line bg-warning-bg p-2">
          {data.errors.map((e, i) => (
            <p key={i} className="text-xs text-warning-fg">
              {t('previewPanel.errorLine', {
                item: e.item_title,
                src: e.src_path,
                error: e.error,
              })}
            </p>
          ))}
        </div>
      )}
      {data && data.total === 0 && !data.errors?.length && (
        <p className="text-xs text-fg-faint">{t('previewPanel.noMatches')}</p>
      )}
    </div>
  )
}
