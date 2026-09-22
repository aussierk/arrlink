import { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react'
import {
  LayoutDashboard,
  ListChecks,
  Menu,
  ScrollText,
  Settings as SettingsIcon,
  Tags as TagsIcon,
} from 'lucide-react'
import { api, type Me } from './lib/api'
import { useAuth } from './lib/useAuth'
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

/** Layout for everything behind RequireAuth. On lg+ the sidebar is a static
 * rail; below lg it collapses into a slide-in drawer opened from a top bar.
 * Nav clicks are plain <NavLink>s -- a page with unsaved edits (e.g. Tags)
 * blocks navigation away from itself via react-router's useBlocker, which
 * applies regardless of which nav surface (rail, drawer, SettingsNav, the
 * browser back button) triggered it. See pages/Tags.tsx. */
export default function Shell() {
  const { me } = useAuth()

  useDocumentTitle(me?.app_title)

  return (
    <ToastProvider>
      <ConfirmProvider>
        <ShellLayout me={me} />
      </ConfirmProvider>
    </ToastProvider>
  )
}

const navLinkCls = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
    isActive ? 'bg-accent-bg text-accent' : 'text-fg-muted hover:bg-fill hover:text-fg'
  }`

/** Sidebar body -- rendered once in the static rail and once in the mobile
 * drawer. `onNavigate` closes the drawer after a link is followed. */
function SidebarNav({ me, onNavigate }: { me: Me | null; onNavigate?: () => void }) {
  const { t } = useTranslation()
  return (
    <>
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
            onClick={onNavigate}
            className={navLinkCls}
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
    </>
  )
}

function ShellLayout({ me }: { me: Me | null }) {
  const { t } = useTranslation()
  const [navOpen, setNavOpen] = useState(false)

  // Close the drawer when the viewport grows past the lg breakpoint, so it
  // can't be left "open" (scroll-locked) behind the now-visible static rail.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)')
    const close = () => {
      if (mq.matches) setNavOpen(false)
    }
    mq.addEventListener('change', close)
    return () => mq.removeEventListener('change', close)
  }, [])

  return (
    <div className="flex min-h-screen">
      <a
        href="#main"
        className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:left-3 focus-visible:top-3 focus-visible:z-50 focus-visible:rounded-md focus-visible:bg-primary focus-visible:px-3 focus-visible:py-1.5 focus-visible:text-sm focus-visible:text-primary-fg"
      >
        {t('a11y.skipToContent')}
      </a>

      {/* Static rail -- lg and up */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-surface/60 p-4 lg:flex">
        <SidebarNav me={me} />
      </aside>

      {/* Slide-in drawer -- below lg. Headless UI gives focus trap + scroll
          lock + Escape; only ever opened by the lg:hidden top-bar button. */}
      <Dialog open={navOpen} onClose={setNavOpen} className="relative z-50 lg:hidden">
        <DialogBackdrop
          transition
          className="fixed inset-0 bg-black/60 transition duration-150 data-closed:opacity-0 motion-reduce:transition-none"
        />
        <DialogPanel
          transition
          className="fixed inset-y-0 left-0 flex w-64 max-w-[80vw] flex-col border-r border-line bg-surface p-4 shadow-xl transition duration-150 data-closed:-translate-x-full motion-reduce:transition-none motion-reduce:data-closed:translate-x-0"
        >
          <DialogTitle className="sr-only">{t('nav.menu')}</DialogTitle>
          <SidebarNav me={me} onNavigate={() => setNavOpen(false)} />
        </DialogPanel>
      </Dialog>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar -- below lg only */}
        <header className="flex items-center gap-3 border-b border-line bg-surface/60 px-4 py-3 lg:hidden">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label={t('a11y.openMenu')}
            className="-m-1 rounded-md p-1 text-fg-muted hover:bg-fill hover:text-fg focus-visible:focus-ring"
          >
            <Menu className="size-5" />
          </button>
          <span className="text-sm font-semibold tracking-tight text-fg">
            {me?.app_title ?? t('app.name')}
          </span>
        </header>

        <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
