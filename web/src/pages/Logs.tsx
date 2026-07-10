import { useCallback, useEffect, useState } from 'react'
import { api, fmtTime, type LogEntry } from '../lib/api'

export default function Logs() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [level, setLevel] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setLogs(await api.listLogs(level || undefined))
    } catch (e) {
      setErr(String(e))
    }
  }, [level])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-6">
      <div className="flex items-end gap-3">
        <div>
          <h2 className="text-xl font-semibold">Logs</h2>
          <p className="text-sm text-zinc-500">
            Live SSE stream arrives with M3.
          </p>
        </div>
        <select
          className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-200"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
        >
          <option value="">all levels</option>
          <option value="error">error</option>
          <option value="warn">warn</option>
          <option value="info">info</option>
        </select>
        <button
          onClick={() => void load()}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900"
        >
          refresh
        </button>
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
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Level</th>
              <th className="px-3 py-2">Message</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {logs.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-zinc-500">
                  No events yet.
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
