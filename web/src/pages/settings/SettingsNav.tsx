import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { KeyRound, Link2, Server, ShieldCheck } from 'lucide-react'

const items = [
  { to: '/settings/general', labelKey: 'settingsNav.general', icon: Link2 },
  { to: '/settings/services', labelKey: 'settingsNav.services', icon: Server },
  { to: '/settings/authentication', labelKey: 'settingsNav.authentication', icon: KeyRound },
  { to: '/settings/access', labelKey: 'settingsNav.access', icon: ShieldCheck },
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
