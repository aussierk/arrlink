import { useCallback, useEffect, useState } from 'react'
import { api, errorMessage, type LogEntry } from './api'

/** Tailwind text class for an event level -- shared by the Logs table and the
 * dashboard activity feed so they never drift. */
export function logLevelClass(level: string): string {
  return level === 'error'
    ? 'text-danger-fg'
    : level === 'warn'
      ? 'text-warning-fg'
      : 'text-fg-muted'
}

type Options = {
  /** Server-side `level` filter, also applied to live frames. '' / undefined = all. */
  level?: string
  /** Server-side `rule_id` filter, also applied to live frames. */
  ruleId?: number
  /** Ring-buffer size. */
  cap?: number
  /** Start with the live stream open. */
  live?: boolean
}

/**
 * Event log: an initial fetch plus an optional live SSE tail. Lifted from the
 * logic that used to be inline in pages/Logs.tsx; also drives the dashboard's
 * "Recent activity" card.
 *
 * `error` is the initial-fetch failure (raw string, as pages/Logs.tsx has
 * always shown it) for the caller to render inline -- never a toast. A dropped
 * live stream is left to EventSource's own auto-reconnect, silently.
 */
export function useLogStream(opts: Options = {}) {
  const { level, ruleId, cap = 500 } = opts
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(opts.live ?? true)

  const matches = useCallback(
    (e: LogEntry) =>
      (!level || e.level === level) && (ruleId == null || e.rule_id === ruleId),
    [level, ruleId],
  )

  const reload = useCallback(async () => {
    try {
      setError(null)
      const rows = await api.listLogs(level || undefined, ruleId)
      setLogs(rows.slice(0, cap))
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [level, ruleId, cap])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!live) return
    const es = new EventSource('/api/logs/stream')
    es.onmessage = (ev) => {
      try {
        const e = JSON.parse(ev.data as string) as LogEntry
        if (!matches(e)) return
        setLogs((prev) =>
          prev.some((x) => x.id === e.id) ? prev : [e, ...prev].slice(0, cap),
        )
      } catch {
        /* ignore malformed frames */
      }
    }
    return () => es.close()
  }, [live, cap, matches])

  return { logs, error, live, setLive, reload }
}
