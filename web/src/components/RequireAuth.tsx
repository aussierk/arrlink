import { useEffect, useState } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api, type Me } from '../lib/api'

/**
 * Route guard for everything except /login. Only decides whether there's an
 * authenticated session and redirects to /login (preserving the current
 * path as `next`) when there isn't — all auto-login / password / OIDC
 * sign-in logic lives in LoginPage, not here.
 */
export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const location = useLocation()
  const [me, setMe] = useState<Me | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setFailed(true))
  }, [])

  if (failed) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-sm text-red-300">
        {t('loginPage.apiUnreachable')}
      </div>
    )
  }

  if (!me) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-zinc-500">
        {t('loginPage.checking')}
      </div>
    )
  }

  if (!me.authenticated) {
    const next = location.pathname + location.search
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />
  }

  return <>{children}</>
}
