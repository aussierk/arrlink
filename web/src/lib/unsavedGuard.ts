import { useEffect } from 'react'

/**
 * Native browser prompt for closing the tab / refreshing / typing a new URL
 * directly. Can't be customized or made async (browsers show their own
 * generic "leave site?" text), but it still stops an accidental close.
 *
 * In-app navigation (sidebar nav, SettingsNav, the browser back/forward
 * buttons) is guarded separately via react-router's own `useBlocker` -- this
 * hook only covers what useBlocker structurally can't (anything that isn't
 * a client-side route change).
 */
export function useBeforeUnloadGuard(hasUnsaved: boolean) {
  useEffect(() => {
    if (!hasUnsaved) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasUnsaved])
}
