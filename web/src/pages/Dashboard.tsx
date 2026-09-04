import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import LinksPanel from '../components/LinksPanel'
import Card from '../components/ui/Card'
import { api, fmtTime, type AppItem, type Health, type Me } from '../lib/api'

export default function Dashboard() {
  const { t } = useTranslation()
  const [health, setHealth] = useState<Health | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [apps, setApps] = useState<AppItem[]>([])
  const [linksCount, setLinksCount] = useState<{
    active_links: number
    stale_links: number
    orphaned_rules: string[]
  } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [h, m, a, s] = await Promise.all([
        api.health(),
        api.me(),
        api.listApps(),
        api.summary(),
      ])
      setHealth(h)
      setMe(m)
      setApps(a)
      setLinksCount(s)
    } catch (e) {
      setErr(String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t('dashboard.title')}</h2>
        <p className="text-sm text-fg-subtle">{t('dashboard.subtitle')}</p>
      </div>

      {err && (
        <div className="rounded-md border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg">
          {err}
        </div>
      )}

      {linksCount && linksCount.orphaned_rules.length > 0 && (
        <div className="rounded-md border border-warning-line bg-warning-bg p-3 text-sm text-warning-fg">
          <p className="font-medium">
            {t('dashboard.orphanedRules', { count: linksCount.orphaned_rules.length })}
          </p>
          <p className="mt-1 text-warning-fg/80">
            {linksCount.orphaned_rules.join(', ')}
          </p>
          <p className="mt-1 text-warning-fg/70">
            <Trans i18nKey="dashboard.orphanedHint">
              Edit the rules, or set{' '}
              <code className="rounded bg-black/30 px-1">allowed_roots</code> to include
              their destination in Settings.
            </Trans>
          </p>
        </div>
      )}

      {me && !me.password_enabled && !me.oidc_enabled && (
        <div className="rounded-md border border-warning-line bg-warning-bg p-3 text-sm text-warning-fg">
          <p className="font-medium">{t('dashboard.authDisabledWarning')}</p>
          <p className="mt-1 text-warning-fg/70">
            <Trans i18nKey="dashboard.authDisabledHint">
              Anyone who can reach this app can use it, with no login. Turn on password or
              OIDC login in{' '}
              <Link
                className="underline hover:text-warning-fg"
                to="/settings/authentication"
              >
                Settings → Authentication
              </Link>
              .
            </Trans>
          </p>
        </div>
      )}

      <div className="grid grid-cols-4 gap-4">
        <Card title={t('dashboard.statusCard')}>
          {health ? (
            <div className="space-y-1 text-sm">
              <p>
                <span
                  className={
                    health.status === 'ok' ? 'text-success-fg' : 'text-danger-fg'
                  }
                >
                  ● {health.status}
                </span>
              </p>
              <p className="text-fg-muted">
                {t('dashboard.version', { version: health.version })}
              </p>
              <p className="text-fg-muted">
                {t('dashboard.schemaVersion', { version: health.schema_version })}
              </p>
            </div>
          ) : (
            <p className="text-sm text-fg-subtle">{t('common.loading')}</p>
          )}
        </Card>
        <Card title={t('dashboard.authCard')}>
          {me ? (
            <div className="space-y-1 text-sm">
              <p className="text-fg-soft">
                {t('dashboard.authMethodsLine', {
                  methods:
                    [
                      me.password_enabled && t('dashboard.methodPassword'),
                      me.oidc_enabled && t('dashboard.methodOidc'),
                    ]
                      .filter(Boolean)
                      .join(', ') || t('dashboard.methodNone'),
                })}
              </p>
              <p className="text-fg-subtle">{t('dashboard.signedIn')}</p>
            </div>
          ) : (
            <p className="text-sm text-fg-subtle">{t('common.loading')}</p>
          )}
        </Card>
        <Card title={t('dashboard.appsCard')}>
          <p className="text-2xl font-semibold">{apps.length}</p>
          <p className="text-sm text-fg-subtle">
            {t('dashboard.appsConnectedCount', { count: apps.length })}
          </p>
        </Card>
        <Card title={t('dashboard.linksCard')}>
          <p className="text-2xl font-semibold">{linksCount?.active_links ?? 0}</p>
          <p className="text-sm text-fg-subtle">
            {t('dashboard.hardlinked')}
            {linksCount?.stale_links
              ? t('dashboard.staleSuffix', { count: linksCount.stale_links })
              : ''}
          </p>
        </Card>
      </div>

      <Card title={t('dashboard.connectedApps')}>
        {apps.length === 0 ? (
          <p className="text-sm text-fg-subtle">{t('dashboard.noApps')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {apps.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2 text-sm">
                <span
                  className={
                    a.type === 'radarr'
                      ? 'rounded bg-radarr-bg px-2 py-0.5 text-xs text-radarr-fg'
                      : 'rounded bg-sonarr-bg px-2 py-0.5 text-xs text-sonarr-fg'
                  }
                >
                  {a.type}
                </span>
                <span className="font-medium">{a.name}</span>
                <span className="text-fg-subtle">{a.url}</span>
                <span className="ml-auto text-fg-subtle">
                  {t('dashboard.lastPoll', { time: fmtTime(a.last_poll_at) })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={t('dashboard.linksCard')}>
        <LinksPanel />
      </Card>
    </div>
  )
}
