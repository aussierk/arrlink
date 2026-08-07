import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { api, readAuthErrorCookie, type Me } from '../lib/api'
import { inputCls } from '../lib/ui'

/** Only accept a same-origin relative path — mirrors the backend's own
 * open-redirect guard on the OIDC callback's next_path. A prefix check
 * alone isn't enough: browsers normalize a leading backslash to "/" when
 * resolving a relative reference against an http(s) base (WHATWG URL
 * spec), so "/\\evil.com" would still resolve off-site past a "//" check
 * alone — reject backslashes outright too. */
function sanitizeNext(raw: string | null): string {
  if (!raw || raw.includes('\\') || !raw.startsWith('/') || raw.startsWith('//')) {
    return '/'
  }
  try {
    const parsed = new URL(raw, window.location.origin)
    if (parsed.origin !== window.location.origin) return '/'
  } catch {
    return '/'
  }
  return raw
}

/**
 * Dedicated /login route — the only route RequireAuth never gates.
 *
 * When OIDC is enabled with auto-login on, this redirects straight to the
 * provider (same instant behavior the old AuthGate had). The escape hatch
 * to skip that and reach the manual password/SSO chooser is the URL itself:
 * /login?form=true — not surfaced anywhere in the UI, by design (see
 * README's Auth setup section).
 */
export default function LoginPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = sanitizeNext(params.get('next'))
  const skipAutoLogin = params.get('form') === 'true'

  const [me, setMe] = useState<Me | null>(null)
  const [apiError, setApiError] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [pwError, setPwError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const err = readAuthErrorCookie()
    if (err) {
      setAuthError(
        err === 'not_authorized' ? t('loginPage.notAuthorized') : t('loginPage.signInFailed', { reason: err }),
      )
      document.cookie = 'arrlink_auth_error=; Max-Age=0; path=/'
    }
    api.me().then(setMe).catch(() => setApiError(true))
  }, [t])

  const autoRedirect =
    me !== null && !me.authenticated && me.oidc_enabled && me.auto_login && !skipAutoLogin && !authError

  useEffect(() => {
    if (!me) return
    if (me.authenticated) {
      navigate(next, { replace: true })
      return
    }
    if (autoRedirect) {
      window.location.assign(`/api/auth/login?next=${encodeURIComponent(next)}`)
    }
  }, [me, autoRedirect])

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault()
    setPwError(null)
    setSubmitting(true)
    try {
      const ok = await api.loginWithPassword(username, password)
      if (ok) {
        navigate(next, { replace: true })
      } else {
        setPwError(t('loginPage.wrongCredentials'))
      }
    } catch {
      setPwError(t('loginPage.signInFailedGeneric'))
    } finally {
      setSubmitting(false)
    }
  }

  if (apiError) {
    return (
      <div className="flex min-h-screen items-center justify-center p-8 text-sm text-red-300">
        {t('loginPage.apiUnreachable')}
      </div>
    )
  }

  if (!me || me.authenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-zinc-500">
        {t('loginPage.checking')}
      </div>
    )
  }

  if (autoRedirect) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-zinc-500">
        {t('loginPage.redirecting')}
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-8">
      <div className="w-full max-w-sm space-y-4">
        <div className="text-center">
          <h1 className="text-lg font-semibold text-zinc-100">{t('app.name')}</h1>
          <p className="text-sm text-zinc-500">{t('loginPage.title')}</p>
        </div>

        {authError && (
          <div className="rounded-md border border-red-900 bg-red-950/40 p-2 text-center text-sm text-red-300">
            {authError}
          </div>
        )}

        {me.oidc_enabled && (
          <button
            onClick={() => window.location.assign(`/api/auth/login?next=${encodeURIComponent(next)}`)}
            className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            {t('loginPage.ssoButton')}
          </button>
        )}

        {me.oidc_enabled && me.password_enabled && (
          <div className="flex items-center gap-3 text-xs text-zinc-600">
            <div className="h-px flex-1 bg-zinc-800" />
            {t('loginPage.orDivider')}
            <div className="h-px flex-1 bg-zinc-800" />
          </div>
        )}

        {me.password_enabled && (
          <form onSubmit={submitPassword} className="space-y-2">
            <label className="block text-sm">
              <span className="mb-1 block text-zinc-400">{t('loginPage.usernameLabel')}</span>
              <input
                className={inputCls}
                type="text"
                required
                autoFocus
                autoComplete="username"
                placeholder={t('loginPage.usernamePlaceholder')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-zinc-400">{t('loginPage.passwordLabel')}</span>
              <input
                className={inputCls}
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {pwError && <p className="text-sm text-red-400">{pwError}</p>}
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md border border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            >
              {t('loginPage.passwordSubmit')}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
