import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import LinksPanel from '../components/LinksPanel'
import {
  api,
  fmtTime,
  type AppItem,
  type Health,
  type Me,
} from '../lib/api'

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
        <p className="text-sm text-zinc-500">{t('dashboard.subtitle')}</p>
      </div>

      {err && (
        <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
          {err}
        </div>
      )}

      {linksCount && linksCount.orphaned_rules.length > 0 && (
        <div className="rounded-md border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-300">
          <p className="font-medium">
            {t('dashboard.orphanedRules', { count: linksCount.orphaned_rules.length })}
          </p>
          <p className="mt-1 text-amber-200/80">{linksCount.orphaned_rules.join(', ')}</p>
          <p className="mt-1 text-amber-200/60">
            <Trans i18nKey="dashboard.orphanedHint">
              Edit the rules, or set <code className="rounded bg-black/30 px-1">allowed_roots</code> to
              include their destination in Settings.
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
                    health.status === 'ok'
                      ? 'text-emerald-400'
                      : 'text-red-400'
                }>
                  ● {health.status}
                </span>
              </p>
              <p className="text-zinc-400">{t('dashboard.version', { version: health.version })}</p>
              <p className="text-zinc-400">{t('dashboard.schemaVersion', { version: health.schema_version })}</p>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">{t('common.loading')}</p>
          )}
        </Card>
        <Card title={t('dashboard.authCard')}>
          {me ? (
            <div className="space-y-1 text-sm">
              <p className="text-zinc-300">{t('dashboard.authModeLine', { mode: me.auth_mode })}</p>
              <p className="text-zinc-500">
                {me.authenticated
                  ? t('dashboard.signedIn')
                  : t('dashboard.oidcComing')}
              </p>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">{t('common.loading')}</p>
          )}
        </Card>
        <Card title={t('dashboard.appsCard')}>
          <p className="text-2xl font-semibold">{apps.length}</p>
          <p className="text-sm text-zinc-500">
            {t('dashboard.appsConnectedCount', { count: apps.length })}
          </p>
        </Card>
        <Card title={t('dashboard.linksCard')}>
          <p className="text-2xl font-semibold">
            {linksCount?.active_links ?? 0}
          </p>
          <p className="text-sm text-zinc-500">
            {t('dashboard.hardlinked')}
            {linksCount?.stale_links
              ? t('dashboard.staleSuffix', { count: linksCount.stale_links })
              : ''}
          </p>
        </Card>
      </div>

      <Card title={t('dashboard.connectedApps')}>
        {apps.length === 0 ? (
          <p className="text-sm text-zinc-500">{t('dashboard.noApps')}</p>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {apps.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2 text-sm">
                <span
                  className={
                    a.type === 'radarr'
                      ? 'rounded bg-rose-600/20 px-2 py-0.5 text-xs text-rose-300'
                      : 'rounded bg-sky-600/20 px-2 py-0.5 text-xs text-sky-300'
                  }
                >
                  {a.type}
                </span>
                <span className="font-medium">{a.name}</span>
                <span className="text-zinc-500">{a.url}</span>
                <span className="ml-auto text-zinc-500">
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

function Card({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {title}
      </h3>
      {children}
    </div>
  )
}
