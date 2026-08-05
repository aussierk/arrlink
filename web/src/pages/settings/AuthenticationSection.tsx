import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../lib/api'
import { inputCls } from '../../lib/ui'
import Toggle from '../../components/ui/Toggle'

/**
 * Password and OIDC login are independent — either, both, or neither can be
 * enabled at once (see /login, which offers whichever are on). Toggling
 * either applies immediately. Secret fields are blank = keep the current
 * value; only a new value replaces it (secrets are never returned to the UI).
 */
export default function AuthenticationSection() {
  const { t } = useTranslation()
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  const [passwordEnabled, setPasswordEnabled] = useState(false)
  const [oidcEnabled, setOidcEnabled] = useState(false)
  const [autoLogin, setAutoLogin] = useState(true)
  const [uiUsername, setUiUsername] = useState('admin')
  const [uiPassword, setUiPassword] = useState('')
  const [uiPasswordSet, setUiPasswordSet] = useState(false)
  const [oidcIssuer, setOidcIssuer] = useState('')
  const [oidcClientId, setOidcClientId] = useState('')
  const [oidcClientSecret, setOidcClientSecret] = useState('')
  const [oidcClientSecretSet, setOidcClientSecretSet] = useState(false)
  const [oidcRedirectUri, setOidcRedirectUri] = useState('')

  const load = useCallback(async () => {
    try {
      const a = await api.getAuthSettings()
      setPasswordEnabled(a.password_enabled)
      setOidcEnabled(a.oidc_enabled)
      setAutoLogin(a.auto_login)
      setUiUsername(a.ui_username)
      setUiPassword('')
      setUiPasswordSet(a.ui_password_set)
      setOidcIssuer(a.oidc_issuer)
      setOidcClientId(a.oidc_client_id)
      setOidcClientSecret('')
      setOidcClientSecretSet(a.oidc_client_secret_set)
      setOidcRedirectUri(a.oidc_redirect_uri)
    } catch (e) {
      setErr(String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function save() {
    setErr(null)
    setOk(null)
    try {
      await api.updateAuthSettings({
        password_enabled: passwordEnabled,
        oidc_enabled: oidcEnabled,
        auto_login: autoLogin,
        ui_username: uiUsername || undefined,
        ui_password: uiPassword || undefined,
        oidc_issuer: oidcIssuer || undefined,
        oidc_client_id: oidcClientId || undefined,
        oidc_client_secret: oidcClientSecret || undefined,
        oidc_redirect_uri: oidcRedirectUri || null,
      })
      setOk(t('settingsAuth.saved'))
      await load()
    } catch (e) {
      setErr(String(e))
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">{t('settingsAuth.title')}</h3>
        <p className="text-xs text-zinc-500">{t('settingsAuth.subtitle')}</p>
      </div>

      {err && (
        <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
          {err}
        </div>
      )}
      {ok && (
        <div className="rounded-md border border-emerald-900 bg-emerald-950/40 p-3 text-sm text-emerald-300">
          {ok}
        </div>
      )}

      <Toggle
        checked={passwordEnabled}
        onChange={setPasswordEnabled}
        label={t('settingsAuth.enablePassword')}
      />
      {passwordEnabled && (
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">{t('settingsAuth.username')}</span>
          <input
            className={inputCls}
            value={uiUsername}
            onChange={(e) => setUiUsername(e.target.value)}
            placeholder={t('settingsAuth.usernamePlaceholder')}
            autoComplete="username"
          />
        </label>
      )}
      {passwordEnabled && (
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">
            {t('settingsAuth.uiPassword')}{' '}
            {uiPasswordSet && (
              <span className="text-zinc-600">{t('settingsAuth.setBlankToKeep')}</span>
            )}
          </span>
          <input
            className={inputCls}
            type="password"
            value={uiPassword}
            onChange={(e) => setUiPassword(e.target.value)}
            placeholder={
              uiPasswordSet
                ? t('settingsAuth.uiPasswordPlaceholderSet')
                : t('settingsAuth.uiPasswordPlaceholderUnset')
            }
            autoComplete="new-password"
          />
        </label>
      )}

      <Toggle
        checked={oidcEnabled}
        onChange={setOidcEnabled}
        label={t('settingsAuth.enableOidc')}
      />
      {oidcEnabled && (
        <div className="space-y-3 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-3">
          <Toggle
            checked={autoLogin}
            onChange={setAutoLogin}
            label={t('settingsAuth.autoLoginLabel')}
          />
          <div className="grid grid-cols-2 gap-3">
            <label className="col-span-2 block text-sm">
              <span className="mb-1 block text-zinc-400">{t('settingsAuth.oidcIssuer')}</span>
              <input
                className={inputCls}
                value={oidcIssuer}
                onChange={(e) => setOidcIssuer(e.target.value)}
                placeholder={t('settingsAuth.oidcIssuerPlaceholder')}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-zinc-400">{t('settingsAuth.clientId')}</span>
              <input
                className={inputCls}
                value={oidcClientId}
                onChange={(e) => setOidcClientId(e.target.value)}
                placeholder={t('settingsAuth.clientIdPlaceholder')}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-zinc-400">
                {t('settingsAuth.clientSecret')}{' '}
                {oidcClientSecretSet && (
                  <span className="text-zinc-600">{t('settingsAuth.setBlankToKeep')}</span>
                )}
              </span>
              <input
                className={inputCls}
                type="password"
                value={oidcClientSecret}
                onChange={(e) => setOidcClientSecret(e.target.value)}
                placeholder={
                  oidcClientSecretSet
                    ? t('settingsAuth.clientSecretPlaceholderSet')
                    : t('settingsAuth.clientSecretPlaceholderUnset')
                }
                autoComplete="new-password"
              />
            </label>
            <label className="col-span-2 block text-sm">
              <span className="mb-1 block text-zinc-400">
                {t('settingsAuth.redirectUri')} <span className="text-zinc-600">{t('settingsAuth.redirectUriHint')}</span>
              </span>
              <input
                className={inputCls}
                value={oidcRedirectUri}
                onChange={(e) => setOidcRedirectUri(e.target.value)}
                placeholder={t('settingsAuth.redirectUriPlaceholder')}
              />
            </label>
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={() => void save()}
          className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
        >
          {t('settingsAuth.save')}
        </button>
      </div>
    </div>
  )
}
