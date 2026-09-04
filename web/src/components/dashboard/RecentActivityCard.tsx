import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import Card from '../ui/Card'
import { fmtRelative, type LogEntry } from '../../lib/api'
import { logLevelClass, useLogStream } from '../../lib/useLogStream'

function ActivityRow({ l }: { l: LogEntry }) {
  const body = <span className="min-w-0 flex-1 text-fg-soft">{l.message}</span>
  const linked =
    l.rule_id != null ? (
      <Link
        to={`/logs?rule=${l.rule_id}`}
        className="min-w-0 flex-1 text-fg-soft hover:underline focus-visible:focus-ring"
      >
        {l.message}
      </Link>
    ) : l.app_id != null ? (
      <Link
        to="/settings/services"
        className="min-w-0 flex-1 text-fg-soft hover:underline focus-visible:focus-ring"
      >
        {l.message}
      </Link>
    ) : (
      body
    )
  return (
    <li className="flex items-baseline gap-2 py-1.5 text-sm">
      <span className="shrink-0 whitespace-nowrap text-xs text-fg-subtle">
        {fmtRelative(l.ts)}
      </span>
      <span className={`shrink-0 text-xs ${logLevelClass(l.level)}`}>{l.level}</span>
      {linked}
    </li>
  )
}

/** Live feed of the most recent poller / link events. Initial fetch + SSE
 * tail via useLogStream; errors render inline (never a toast). */
export default function RecentActivityCard() {
  const { t } = useTranslation()
  const { logs, error } = useLogStream({ cap: 8 })

  return (
    <Card
      title={t('dashboard.activityTitle')}
      actions={
        <Link
          to="/logs"
          className="text-xs text-accent hover:underline focus-visible:focus-ring"
        >
          {t('dashboard.viewAllLogs')}
        </Link>
      }
    >
      {error ? (
        <p className="text-sm text-danger-fg">{t('dashboard.activityError')}</p>
      ) : logs.length === 0 ? (
        <p className="text-sm text-fg-subtle">{t('dashboard.activityEmpty')}</p>
      ) : (
        <ul className="max-h-72 divide-y divide-line overflow-y-auto">
          {logs.map((l) => (
            <ActivityRow key={l.id} l={l} />
          ))}
        </ul>
      )}
    </Card>
  )
}
