import { useEffect } from 'react'

/** Sets the browser tab title. index.html's static <title> stays as the
 * pre-JS fallback (first paint, before this runs) — this keeps it in sync
 * with the configurable Application Title once the app has loaded. */
export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    if (title) document.title = title
  }, [title])
}
