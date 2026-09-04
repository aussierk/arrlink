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
import { ConfirmProvider } from './lib/useConfirm'
import { ToastProvider } from './lib/useToast'
import ThemeToggle from './components/ui/ThemeToggle'

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
    <ToastProvider>
      <ConfirmProvider>
        <ShellLayout me={me} />
      </ConfirmProvider>
    </ToastProvider>
  )
}

function ShellLayout({ me }: { me: Me | null }) {
  const { t } = useTranslation()
  return (
    <div className="flex min-h-screen">
      <a
        href="#main"
        className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:left-3 focus-visible:top-3 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-primary focus-visible:px-3 focus-visible:py-1.5 focus-visible:text-sm focus-visible:text-primary-fg"
      >
        {t('a11y.skipToContent')}
      </a>
      <aside className="flex w-56 shrink-0 flex-col border-r border-line bg-surface/60 p-4">
        <div className="mb-8">
          <h1 className="text-lg font-semibold tracking-tight text-fg">
            {me?.app_title ?? t('app.name')}
          </h1>
          <p className="text-xs text-fg-subtle">{t('app.tagline')}</p>
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
                    ? 'bg-accent-bg text-accent'
                    : 'text-fg-muted hover:bg-fill hover:text-fg'
                }`
              }
            >
              <i.icon className="size-4" />
              {t(i.labelKey)}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-3 border-t border-line pt-4">
          <ThemeToggle />
          {me?.email && (
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs text-fg-muted" title={me.email ?? ''}>
                {me.name || me.email}
              </span>
              <button
                onClick={() => void api.logout()}
                className="text-xs text-fg-subtle hover:text-danger-fg"
              >
                {t('app.signOut')}
              </button>
            </div>
          )}
        </div>
      </aside>
      <main id="main" tabIndex={-1} className="flex-1 p-8">
        <Outlet />
      </main>
    </div>
  )
}
