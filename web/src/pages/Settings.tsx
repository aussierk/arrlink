import { Navigate, Route, Routes } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import SettingsNav from './settings/SettingsNav'
import GeneralSection from './settings/GeneralSection'
import ServicesSection from './settings/ServicesSection'
import AuthenticationSection from './settings/AuthenticationSection'
import AccessControlSection from './settings/AccessControlSection'
import VocabularySection from './settings/VocabularySection'

/** Settings shell: header, sub-nav, and the routed section content. */
export default function Settings() {
  const { t } = useTranslation()
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">{t('settings.title')}</h2>
        <p className="text-sm text-zinc-500">{t('settings.subtitle')}</p>
      </div>

      <div className="flex gap-8">
        <SettingsNav />
        <div className="min-w-0 flex-1">
          <Routes>
            <Route index element={<Navigate to="general" replace />} />
            <Route path="general" element={<GeneralSection />} />
            <Route path="services" element={<ServicesSection />} />
            <Route path="authentication" element={<AuthenticationSection />} />
            <Route path="access" element={<AccessControlSection />} />
            <Route path="vocabulary" element={<VocabularySection />} />
          </Routes>
        </div>
      </div>
    </div>
  )
}
