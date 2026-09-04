import { reportClientError } from './api'

/**
 * Global JS-error hooks, wired once from main.tsx. Catches what a React
 * error boundary structurally can't: errors in event handlers, timers,
 * async callbacks, and unhandled promise rejections.
 *
 * Deduped (identical consecutive messages) and rate-capped so a render loop
 * or a flapping network call can't flood the event log.
 */
const MAX_PER_MINUTE = 5

let lastMessage = ''
let windowStart = 0
let countInWindow = 0

function allowed(message: string): boolean {
  const now = Date.now()
  if (now - windowStart > 60_000) {
    windowStart = now
    countInWindow = 0
  }
  if (message === lastMessage || countInWindow >= MAX_PER_MINUTE) return false
  lastMessage = message
  countInWindow += 1
  return true
}

function describe(value: unknown, fallback: string): { message: string; stack: string } {
  if (value instanceof Error) {
    return { message: `${value.name}: ${value.message}`, stack: value.stack ?? '' }
  }
  return { message: `${fallback}: ${String(value)}`, stack: '' }
}

export function registerGlobalErrorHandlers(): void {
  window.addEventListener('error', (e) => {
    const { message, stack } = describe(e.error ?? e.message, 'Error')
    if (allowed(message)) reportClientError({ message, stack })
  })
  window.addEventListener('unhandledrejection', (e) => {
    const { message, stack } = describe(e.reason, 'Unhandled rejection')
    if (allowed(message)) reportClientError({ message, stack })
  })
}
