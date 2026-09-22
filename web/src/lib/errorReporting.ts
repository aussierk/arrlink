import { reportClientError } from './api'

/** Global JS-error hooks, wired once from main.tsx -- catches what a React
 * error boundary can't (event handlers, timers, async callbacks, unhandled
 * rejections). Deduped and rate-capped so a render loop can't flood the
 * event log. */
const MAX_PER_MINUTE = 5

/** A factory, not module-level state, so independent call sites don't
 * share a rate-limit window and tests can create isolated instances. */
export function createRateLimiter(maxPerMinute: number, now: () => number = Date.now) {
  let lastMessage = ''
  let windowStart = 0
  let countInWindow = 0

  return function allowed(message: string): boolean {
    const t = now()
    if (t - windowStart > 60_000) {
      windowStart = t
      countInWindow = 0
    }
    if (message === lastMessage || countInWindow >= maxPerMinute) return false
    lastMessage = message
    countInWindow += 1
    return true
  }
}

export function describeThrown(value: unknown, fallback: string): {
  message: string
  stack: string
} {
  if (value instanceof Error) {
    return { message: `${value.name}: ${value.message}`, stack: value.stack ?? '' }
  }
  return { message: `${fallback}: ${String(value)}`, stack: '' }
}

export function registerGlobalErrorHandlers(): void {
  const allowed = createRateLimiter(MAX_PER_MINUTE)
  window.addEventListener('error', (e) => {
    const { message, stack } = describeThrown(e.error ?? e.message, 'Error')
    if (allowed(message)) reportClientError({ message, stack })
  })
  window.addEventListener('unhandledrejection', (e) => {
    const { message, stack } = describeThrown(e.reason, 'Unhandled rejection')
    if (allowed(message)) reportClientError({ message, stack })
  })
}
