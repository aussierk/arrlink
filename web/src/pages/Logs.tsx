import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, fmtTime, type LogEntry } from '../lib/api'
import Button from '../components/ui/Button'

export default function Logs() {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [level, setLevel] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const esRef = useRef<EventSource | null>(null)

  const load = useCallback(async () => {
    try {
      setLogs(await api.listLogs(level || undefined))
    } catch (e) {
      setErr(String(e))
    }
  }, [level])

  useEffect(() => {
    if (!live) return
    const es = new EventSource('/api/logs/stream')
    esRef.current = es
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data as string) as LogEntry
        setLogs((prev) =>
          prev.some((x) => x.id === e.id) ? prev : [e, ...prev].slice(0, 500),
        )
      } catch {
        /* ignore malformed frames */
      }
    }
    return () => es.close()
  }, [live])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-6">
      <div className="flex items-end gap-3">
        <div>
          <h2 className="text-xl font-semibold">{t('logs.title')}</h2>
          <p className="text-sm text-fg-subtle">{t('logs.subtitle')}</p>
        </div>
        <select
          className="rounded-md border border-line-strong bg-sunken px-2 py-1.5 text-sm text-fg"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
        >
          <option value="">{t('logs.allLevels')}</option>
          <option value="error">{t('logs.error')}</option>
          <option value="warn">{t('logs.warn')}</option>
          <option value="info">{t('logs.info')}</option>
        </select>
        <Button variant="secondary" onClick={() => void load()}>
          {t('common.refresh')}
        </Button>
        <label className="flex items-center gap-2 text-sm text-fg-soft">
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
          />
          {t('logs.live')}
        </label>
      </div>

      {err && (
        <div className="rounded-md border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg">
          {err}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-xs uppercase tracking-wide text-fg-subtle">
            <tr>
              <th scope="col" className="px-3 py-2">
                {t('logs.colTime')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('logs.colLevel')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('logs.colMessage')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {logs.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-fg-subtle">
                  {t('logs.empty')}
                </td>
              </tr>
            )}
            {logs.map((l) => (
              <tr key={l.id} className="bg-sunken/40">
                <td className="whitespace-nowrap px-3 py-2 text-fg-muted">
                  {fmtTime(l.ts)}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={
                      l.level === 'error'
                        ? 'text-danger-fg'
                        : l.level === 'warn'
                          ? 'text-warning-fg'
                          : 'text-fg-muted'
                    }
                  >
                    {l.level}
                  </span>
                </td>
                <td className="px-3 py-2 text-fg">{l.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
