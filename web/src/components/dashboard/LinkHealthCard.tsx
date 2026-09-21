import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import Card from '../ui/Card'
import type { Summary } from '../../lib/api'

/** active / stale / missing link counts — the dashboard's headline. Each is a
 * link into the embedded links table with that filter pre-applied. */
export default function LinkHealthCard({ summary }: { summary: Summary | null }) {
  const { t } = useTranslation()
  const stats = [
    {
      status: 'active',
      n: summary?.active_links,
      label: t('dashboard.linkActive'),
      tone: 'text-success-fg',
    },
    {
      status: 'stale',
      n: summary?.stale_links,
      label: t('dashboard.linkStale'),
      tone: 'text-warning-fg',
    },
    {
      status: 'missing',
      n: summary?.missing_links,
      label: t('dashboard.linkMissing'),
      tone: 'text-danger-fg',
    },
  ]

  return (
    <Card title={t('dashboard.linkHealthTitle')}>
      <div className="grid grid-cols-3 gap-3 text-center">
        {stats.map(({ status, n, label, tone }) => (
          <Link
            key={status}
            to={`/?links=${status}#links`}
            className="rounded-md py-2 transition-colors hover:bg-fill focus-visible:focus-ring"
          >
            <div className={`text-2xl font-semibold ${tone}`}>{n ?? '-'}</div>
            <div className="text-xs text-fg-subtle">{label}</div>
          </Link>
        ))}
      </div>
    </Card>
  )
}
