import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  LayoutDashboard,
  ListChecks,
  ScrollText,
  Settings as SettingsIcon,
  Tags as TagsIcon,
} from 'lucide-react'
import { api, setDisplayTimezone, type Me } from './lib/api'
import { useDocumentTitle } from './lib/useDocumentTitle'

// Links live on the Dashboard (not a standalone tab). Apps live under Settings → Services.
const nav = [
  { to: '/', labelKey: 'nav.dashboard', end: true, icon: LayoutDashboard },
  { to: '/tags', labelKey: 'nav.tags', end: false, icon: TagsIcon },
  { to: '/rules', labelKey: 'nav.rules', end: false, icon: ListChecks },
  { to: '/logs', labelKey: 'nav.logs', end: false, icon: ScrollText },
  { to: '/settings', labelKey: 'nav.settings', end: false, icon: SettingsIcon },
] as const

/** Layout for everything behind RequireAuth: sidebar + routed content. Nav
 * clicks are plain <NavLink>s — a page with unsaved edits (e.g. Tags) blocks
 * navigation away from itself via react-router's useBlocker, which applies
 * regardless of which nav surface (this sidebar, SettingsNav, the browser
 * back button) triggered it. See pages/Tags.tsx. */
export default function Shell() {
  const { t } = useTranslation()
  const [me, setMe] = useState<Me | null>(null)

  useEffect(() => {
    api
      .me()
      .then((m) => {
        setMe(m)
        setDisplayTimezone(m.display_timezone)
      })
      .catch(() => {})
  }, [])

  useDocumentTitle(me?.app_title)

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/60 p-4">
        <div className="mb-8">
          <h1 className="text-lg font-semibold tracking-tight text-zinc-100">
            {me?.app_title ?? t('app.name')}
          </h1>
          <p className="text-xs text-zinc-500">{t('app.tagline')}</p>
        </div>
        <nav className="space-y-1">
          {nav.map((i) => (
            <NavLink
              key={i.to}
              to={i.to}
              end={i.end}
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
        {me?.email && (
          <div className="mt-auto flex items-center justify-between gap-2 border-t border-zinc-800 pt-4">
            <span className="truncate text-xs text-zinc-400" title={me.email ?? ''}>
              {me.name || me.email}
            </span>
            <button
              onClick={() => void api.logout()}
              className="text-xs text-zinc-500 hover:text-red-400"
            >
              {t('app.signOut')}
            </button>
          </div>
        )}
      </aside>
      <main className="flex-1 p-8">
        <Outlet />
      </main>
    </div>
  )
}
