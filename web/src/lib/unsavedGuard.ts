/**
 * Cross-page "you have unsaved changes" guard for in-app navigation.
 *
 * react-router-dom's own `useBlocker` only works with a data router
 * (`createBrowserRouter`/`RouterProvider`) — this app uses the plain
 * `<BrowserRouter>` + `<Routes>` API, where `useBlocker` throws. This is a
 * minimal stand-in: any page can register a check (and a save action) while
 * it has unsaved edits; the sidebar nav (App.tsx) calls it before navigating
 * away and unregisters happens automatically on unmount.
 *
 * Only guards clicks on the in-app sidebar nav — not the browser back/forward
 * buttons, closing the tab, or editing the URL bar directly (those aren't
 * interceptable without a data router). `registerBeforeUnload` below covers
 * the tab-close/refresh case separately, via the standard browser API.
 */

let pending: (() => Promise<boolean>) | null = null
let hasChanges: (() => boolean) | null = null

/** Call from the page that has editable, unsaved state. `save` should
 * persist the pending changes and resolve to whether it succeeded;
 * `hasUnsaved` reports whether there's currently anything to save. Returns
 * an unregister function — call it on unmount (or once there's nothing left
 * to guard). */
export function registerUnsavedGuard(
  hasUnsaved: () => boolean,
  save: () => Promise<boolean>,
) {
  hasChanges = hasUnsaved
  pending = save
  return () => {
    if (hasChanges === hasUnsaved) hasChanges = null
    if (pending === save) pending = null
  }
}

/** Call before an in-app navigation. Resolves to whether it's safe to
 * proceed. Declining to save still proceeds (ask whether to save, then
 * always continue) — but a save that's attempted and fails does NOT, so the
 * page sticks around long enough for its error message (and the unsaved
 * edits) to actually be seen instead of vanishing along with the page. */
export async function confirmNavigation(): Promise<boolean> {
  if (!hasChanges?.() || !pending) return true
  const shouldSave = window.confirm(
    'You have unsaved tag classification changes. Save them before leaving this page?',
  )
  if (!shouldSave) return true
  return pending()
}

/** Native browser prompt for closing the tab / refreshing / typing a new
 * URL — can't be customized or made async, but still stops an accidental
 * close. Call in a useEffect while there are unsaved changes; call the
 * returned cleanup to remove the listener. */
export function registerBeforeUnload(hasUnsaved: () => boolean) {
  const handler = (e: BeforeUnloadEvent) => {
    if (hasUnsaved()) {
      e.preventDefault()
    }
  }
  window.addEventListener('beforeunload', handler)
  return () => window.removeEventListener('beforeunload', handler)
}
