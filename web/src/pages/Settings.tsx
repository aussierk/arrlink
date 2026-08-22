import { Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import SettingsNav from './settings/SettingsNav'

/** Settings shell: header, sub-nav, and the routed section content (see
 * router.tsx for the settings/* children this renders via Outlet). */
export default function Settings() {
  const { t } = useTranslation()
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t('settings.title')}</h2>
        <p className="text-sm text-zinc-500">{t('settings.subtitle')}</p>
      </div>

      <SettingsNav />
      <Outlet />
    </div>
  )
}
