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

/** Secondary nav for the Settings area, styled to match the main sidebar. */
export default function SettingsNav() {
  const { t } = useTranslation()
  return (
    <nav className="w-44 shrink-0 space-y-1">
      {items.map((i) => (
        <NavLink
          key={i.to}
          to={i.to}
          className={({ isActive }) =>
            `flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
              isActive
                ? 'bg-indigo-600/20 text-indigo-300'
                : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
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
