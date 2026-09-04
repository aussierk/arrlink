import { useEffect } from 'react'
import { useRouteError } from 'react-router-dom'
import { reportClientError } from '../lib/api'
import { ErrorFallback } from './ErrorBoundary'

/**
 * Route `errorElement`: react-router renders this instead of unmounting the
 * router when a route's render (or a future loader/action) throws. Reports
 * once, then shows the shared fallback.
 */
export default function RouteError() {
  const error = useRouteError()

  useEffect(() => {
    const err = error instanceof Error ? error : new Error(String(error))
    reportClientError({ message: `Route error: ${err.message}`, stack: err.stack ?? '' })
  }, [error])

  return <ErrorFallback />
}
