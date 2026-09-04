import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { api } from '../../lib/api'
import { inputCls } from '../../lib/ui'
import Field from '../../components/ui/Field'
import { useToast } from '../../lib/useToast'
import SubSection from '../../components/ui/SubSection'
import Toggle from '../../components/ui/Toggle'
import Button from '../../components/ui/Button'

function parseList(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Password and OIDC login are independent — either, both, or neither can be
 * enabled at once (see /login, which offers whichever are on). Both field
 * blocks below are always visible regardless of their "Enable" toggle, so an
 * OIDC issuer/client ID (or a password) can be filled in and saved *before*
 * flipping that method on — the toggle only controls whether it's active for
 * login, not whether its fields are reachable. Secret fields are blank =
 * keep the current value; only a new value replaces it (secrets are never
 * returned to the UI).
 */
export default function AuthenticationSection() {
  const { t } = useTranslation()
  const toast = useToast()

  const [passwordEnabled, setPasswordEnabled] = useState(false)
  const [uiUsername, setUiUsername] = useState('admin')
  const [uiPassword, setUiPassword] = useState('')
  const [uiPasswordSet, setUiPasswordSet] = useState(false)

  const [oidcEnabled, setOidcEnabled] = useState(false)
  const [autoLogin, setAutoLogin] = useState(true)
  const [oidcIssuer, setOidcIssuer] = useState('')
  const [oidcClientId, setOidcClientId] = useState('')
  const [oidcClientSecret, setOidcClientSecret] = useState('')
  const [oidcClientSecretSet, setOidcClientSecretSet] = useState(false)
  const [groupsText, setGroupsText] = useState('')
  const [emailsText, setEmailsText] = useState('')

  const load = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([api.getAuthSettings(), api.getSettings()])
      setPasswordEnabled(a.password_enabled)
      setUiUsername(a.ui_username)
      setUiPassword('')
      setUiPasswordSet(a.ui_password_set)
      setOidcEnabled(a.oidc_enabled)
      setAutoLogin(a.auto_login)
      setOidcIssuer(a.oidc_issuer)
      setOidcClientId(a.oidc_client_id)
      setOidcClientSecret('')
      setOidcClientSecretSet(a.oidc_client_secret_set)
      setGroupsText(((s['oidc_allowed_groups'] as string[] | undefined) ?? []).join(', '))
      setEmailsText(((s['oidc_allowed_emails'] as string[] | undefined) ?? []).join(', '))
    } catch (e) {
      toast.error(String(e))
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  async function save() {
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
      })
      await api.setSetting('oidc_allowed_groups', parseList(groupsText))
      await api.setSetting('oidc_allowed_emails', parseList(emailsText))
      toast.success(t('settingsAuth.saved'))
      await load()
    } catch (e) {
      toast.error(String(e))
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-fg">{t('settingsAuth.title')}</h3>
        <p className="text-xs text-fg-subtle">{t('settingsAuth.subtitle')}</p>
      </div>

      <SubSection title={t('settingsAuth.passwordTitle')}>
        <Field label={t('settingsAuth.enablePassword')}>
          <Toggle checked={passwordEnabled} onChange={setPasswordEnabled} />
        </Field>
        <Field label={t('settingsAuth.username')}>
          <input
            className={inputCls}
            value={uiUsername}
            onChange={(e) => setUiUsername(e.target.value)}
            placeholder={t('settingsAuth.usernamePlaceholder')}
            autoComplete="username"
          />
        </Field>
        <Field
          label={
            <>
              {t('settingsAuth.uiPassword')}
              {uiPasswordSet && (
                <span className="text-fg-faint">{t('settingsAuth.setBlankToKeep')}</span>
              )}
            </>
          }
        >
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
        </Field>
      </SubSection>

      <SubSection title={t('settingsAuth.oidcTitle')}>
        <Field label={t('settingsAuth.enableOidc')}>
          <Toggle checked={oidcEnabled} onChange={setOidcEnabled} />
        </Field>
        <Field
          label={
            <>
              {t('settingsAuth.autoLoginLabel')}
              <span className="mt-0.5 block text-xs text-fg-faint">
                {t('settingsAuth.autoLoginHint')}
              </span>
            </>
          }
        >
          <Toggle checked={autoLogin} onChange={setAutoLogin} />
        </Field>
        <Field label={t('settingsAuth.oidcIssuer')}>
          <input
            className={inputCls}
            value={oidcIssuer}
            onChange={(e) => setOidcIssuer(e.target.value)}
            placeholder={t('settingsAuth.oidcIssuerPlaceholder')}
          />
        </Field>
        <Field label={t('settingsAuth.clientId')}>
          <input
            className={inputCls}
            value={oidcClientId}
            onChange={(e) => setOidcClientId(e.target.value)}
            placeholder={t('settingsAuth.clientIdPlaceholder')}
          />
        </Field>
        <Field
          label={
            <>
              {t('settingsAuth.clientSecret')}
              {oidcClientSecretSet && (
                <span className="text-fg-faint">{t('settingsAuth.setBlankToKeep')}</span>
              )}
            </>
          }
        >
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
        </Field>
        <p className="text-xs text-fg-subtle">
          <Trans i18nKey="settingsAuth.allowListHint">
            Allowed for sign-in: any user whose email is in the email list{' '}
            <span className="text-fg-muted">or</span> whose group is in the group list.
            Both empty = anyone who can sign in with the provider may use ArrLink.
          </Trans>
        </p>
        <Field label={t('settingsAuth.allowedGroups')}>
          <input
            className={inputCls}
            value={groupsText}
            onChange={(e) => setGroupsText(e.target.value)}
            placeholder={t('settingsAuth.allowedGroupsPlaceholder')}
          />
        </Field>
        <Field label={t('settingsAuth.allowedEmails')}>
          <input
            className={inputCls}
            value={emailsText}
            onChange={(e) => setEmailsText(e.target.value)}
            placeholder={t('settingsAuth.allowedEmailsPlaceholder')}
          />
        </Field>
      </SubSection>

      <div className="flex justify-end">
        <Button onClick={() => void save()}>{t('settingsAuth.save')}</Button>
      </div>
    </div>
  )
}
