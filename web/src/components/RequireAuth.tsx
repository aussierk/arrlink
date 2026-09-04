import { Navigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../lib/useAuth'

/**
 * Route guard for everything except /login. Only decides whether there's an
 * authenticated session and redirects to /login (preserving the current
 * path as `next`) when there isn't — all auto-login / password / OIDC
 * sign-in logic lives in LoginPage, not here. The session lookup itself is
 * shared via <AuthProvider> (see lib/useAuth).
 */
export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const location = useLocation()
  const { me, status } = useAuth()

  if (status === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-sm text-danger-fg">
        {t('loginPage.apiUnreachable')}
      </div>
    )
  }

  if (status === 'loading' || !me) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-fg-subtle">
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
