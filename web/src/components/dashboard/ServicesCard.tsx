import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import Card from '../ui/Card'
import { fmtRelative, fmtTime, type AppItem } from '../../lib/api'

function StatusBadge({ app }: { app: AppItem }) {
  const { t } = useTranslation()
  const [label, cls] = app.last_error
    ? [t('dashboard.serviceError'), 'bg-danger-bg text-danger-fg']
    : !app.enabled
      ? [t('dashboard.servicePaused'), 'bg-fill text-fg-muted']
      : [t('dashboard.serviceOnline'), 'bg-success-bg text-success-fg']
  return (
    <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {label}
    </span>
  )
}

/** Per-service health -- connection state, indexed item count, poll timing,
 * and the last error if any. Replaces the bare <ul> the dashboard used to
 * render. */
export default function ServicesCard({ apps }: { apps: AppItem[] | null }) {
  const { t } = useTranslation()

  return (
    <Card
      title={t('dashboard.connectedApps')}
      actions={
        <Link
          to="/settings/services"
          className="text-xs text-accent hover:underline focus-visible:focus-ring"
        >
          {t('dashboard.openInSettings')}
        </Link>
      }
    >
      {apps === null ? (
        <p className="text-sm text-fg-subtle">{t('common.loading')}</p>
      ) : apps.length === 0 ? (
        <p className="text-sm text-fg-subtle">{t('dashboard.noApps')}</p>
      ) : (
        <ul className="divide-y divide-line">
          {apps.map((a) => (
            <li key={a.id} className="space-y-1 py-3 text-sm">
              <div className="flex items-center gap-2">
                <StatusBadge app={a} />
                <span className="shrink-0 font-medium text-fg">{a.name}</span>
                <span
                  className={`shrink-0 rounded px-2 py-0.5 text-xs ${
                    a.type === 'radarr'
                      ? 'bg-radarr-bg text-radarr-fg'
                      : 'bg-sonarr-bg text-sonarr-fg'
                  }`}
                >
                  {a.type}
                </span>
                <span className="min-w-0 truncate text-fg-subtle">{a.url}</span>
              </div>
              <div className="text-xs text-fg-subtle">
                {t('dashboard.itemsIndexed', { count: a.item_count })}
                {' · '}
                {t('dashboard.lastPoll', { time: fmtTime(a.last_poll_at) })}
                {' · '}
                {t('dashboard.nextPoll', {
                  time: a.last_poll_at
                    ? fmtRelative(a.last_poll_at + a.poll_interval_s)
                    : '-',
                })}
              </div>
              {a.last_error && <p className="text-xs text-danger-fg">{a.last_error}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
