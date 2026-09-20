import type { DbClient } from './client.js'
import { events } from './schema.js'

export type EventLevel = 'info' | 'warn' | 'error'

/** Ported from state.py::State.log_event -- also mirrors to the process logger. */
export function logEvent(
  db: DbClient,
  level: EventLevel,
  message: string,
  appId: number | null = null,
  ruleId: number | null = null,
): void {
  db.insert(events)
    .values({ ts: Date.now() / 1000, level, appId, ruleId, message })
    .run()
  const logFn =
    level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  logFn(message)
}
