import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, fmtTime, type LogEntry } from '../lib/api'

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
          <p className="text-sm text-zinc-500">{t('logs.subtitle')}</p>
        </div>
        <select
          className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
        >
          <option value="">{t('logs.allLevels')}</option>
          <option value="error">{t('logs.error')}</option>
          <option value="warn">{t('logs.warn')}</option>
          <option value="info">{t('logs.info')}</option>
        </select>
        <button
          onClick={() => void load()}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900"
        >
          {t('common.refresh')}
        </button>
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
          />
          {t('logs.live')}
        </label>
      </div>

      {err && (
        <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
          {err}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2">{t('logs.colTime')}</th>
              <th className="px-3 py-2">{t('logs.colLevel')}</th>
              <th className="px-3 py-2">{t('logs.colMessage')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {logs.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-zinc-500">
                  {t('logs.empty')}
                </td>
              </tr>
            )}
            {logs.map((l) => (
              <tr key={l.id} className="bg-zinc-950/40">
                <td className="whitespace-nowrap px-3 py-2 text-zinc-400">
                  {fmtTime(l.ts)}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={
                      l.level === 'error'
                        ? 'text-red-400'
                        : l.level === 'warn'
                          ? 'text-amber-400'
                          : 'text-zinc-400'
                    }
                  >
                    {l.level}
                  </span>
                </td>
                <td className="px-3 py-2 text-zinc-200">{l.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
