import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import Card from '../ui/Card'
import type { RuleItem } from '../../lib/api'

/** Rule inventory as a stat block that visually rhymes with LinkHealthCard:
 * total rules, how many are enabled, and how many links they manage. */
export default function RulesCard({ rules }: { rules: RuleItem[] | null }) {
  const { t } = useTranslation()
  const enabled = rules?.filter((r) => r.enabled).length
  const managed = rules?.reduce((sum, r) => sum + r.link_count, 0)

  const stats = [
    { n: rules?.length, label: t('dashboard.rulesTotalLabel'), tone: 'text-fg' },
    { n: enabled, label: t('dashboard.rulesEnabledLabel'), tone: 'text-fg' },
    { n: managed, label: t('dashboard.rulesManagedLabel'), tone: 'text-fg' },
  ]

  return (
    <Card
      title={t('dashboard.rulesTitle')}
      actions={
        <Link
          to="/rules"
          className="text-xs text-accent hover:underline focus-visible:focus-ring"
        >
          {t('dashboard.manageRules')}
        </Link>
      }
    >
      <div className="grid grid-cols-3 gap-3 text-center">
        {stats.map(({ n, label, tone }) => (
          <div key={label} className="py-2">
            <div className={`text-2xl font-semibold ${tone}`}>{n ?? '—'}</div>
            <div className="text-xs text-fg-subtle">{label}</div>
          </div>
        ))}
      </div>
    </Card>
  )
}
