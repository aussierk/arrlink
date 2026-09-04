import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { HardDriveDownload, KeyRound, Library, Link2, Server } from 'lucide-react'

const items = [
  { to: '/settings/general', labelKey: 'settingsNav.general', icon: Link2 },
  { to: '/settings/services', labelKey: 'settingsNav.services', icon: Server },
  {
    to: '/settings/authentication',
    labelKey: 'settingsNav.authentication',
    icon: KeyRound,
  },
  { to: '/settings/vocabulary', labelKey: 'settingsNav.vocabulary', icon: Library },
  { to: '/settings/backup', labelKey: 'settingsNav.backup', icon: HardDriveDownload },
] as const

/** Secondary nav for the Settings area — a horizontal tab bar below the
 * page header, underline indicating the active section. */
export default function SettingsNav() {
  const { t } = useTranslation()
  return (
    <nav className="flex flex-wrap gap-1 border-b border-line">
      {items.map((i) => (
        <NavLink
          key={i.to}
          to={i.to}
          className={({ isActive }) =>
            `flex items-center gap-2 border-b-2 px-3 py-2 text-sm transition-colors ${
              isActive
                ? 'border-ring text-accent'
                : 'border-transparent text-fg-muted hover:border-line-strong hover:text-fg'
            }`
          }
        >
          <i.icon className="size-4" />
          {t(i.labelKey)}
        </NavLink>
      ))}
    </nav>
  )
}
