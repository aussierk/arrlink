import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import LinksPanel from '../components/LinksPanel'
import Card from '../components/ui/Card'
import LinkHealthCard from '../components/dashboard/LinkHealthCard'
import ServicesCard from '../components/dashboard/ServicesCard'
import RulesCard from '../components/dashboard/RulesCard'
import RecentActivityCard from '../components/dashboard/RecentActivityCard'
import { api, type AppItem, type Me, type RuleItem, type Summary } from '../lib/api'
import { useToast } from '../lib/useToast'

export default function Dashboard() {
  const { t } = useTranslation()
  const toast = useToast()
  const [me, setMe] = useState<Me | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [apps, setApps] = useState<AppItem[] | null>(null)
  const [rules, setRules] = useState<RuleItem[] | null>(null)

  const load = useCallback(async () => {
    try {
      const [m, s, a, r] = await Promise.all([
        api.me(),
        api.summary(),
        api.listApps(),
        api.listRules(),
      ])
      setMe(m)
      setSummary(s)
      setApps(a)
      setRules(r)
    } catch (e) {
      toast.error(String(e))
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t('dashboard.title')}</h2>
        <p className="text-sm text-fg-subtle">{t('dashboard.subtitle')}</p>
      </div>

      {summary && summary.orphaned_rules.length > 0 && (
        <div className="rounded-md border border-warning-line bg-warning-bg p-3 text-sm text-warning-fg">
          <p className="font-medium">
            {t('dashboard.orphanedRules', { count: summary.orphaned_rules.length })}
          </p>
          <p className="mt-1 text-warning-fg/80">{summary.orphaned_rules.join(', ')}</p>
          <p className="mt-1 text-warning-fg/70">
            <Trans i18nKey="dashboard.orphanedHint">
              Edit the rules, or add their destination to{' '}
              <code className="rounded bg-black/30 px-1">allowed_roots</code> in Settings.
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <LinkHealthCard summary={summary} />
        <RulesCard rules={rules} />
      </div>

      <ServicesCard apps={apps} />

      <RecentActivityCard />

      <Card id="links" title={t('dashboard.linksCard')}>
        <LinksPanel />
      </Card>
    </div>
  )
}
