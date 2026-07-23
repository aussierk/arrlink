import { useEffect, useState } from 'react'
import { NavLink, Route, Routes } from 'react-router-dom'
import AuthGate from './components/AuthGate'
import { api, type Me } from './lib/api'
import Apps from './pages/Apps'
import Dashboard from './pages/Dashboard'
import Logs from './pages/Logs'
import Rules from './pages/Rules'
import Settings from './pages/Settings'
import Tags from './pages/Tags'

// Links live on the Dashboard (not a standalone tab).
const nav = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/apps', label: 'Apps', end: false },
  { to: '/tags', label: 'Tags', end: false },
  { to: '/rules', label: 'Rules', end: false },
  { to: '/logs', label: 'Logs', end: false },
  { to: '/settings', label: 'Settings', end: false },
]

export default function App() {
  return (
    <AuthGate>
      <Shell />
    </AuthGate>
  )
}

function Shell() {
  const [me, setMe] = useState<Me | null>(null)

  useEffect(() => {
    api.me().then(setMe).catch(() => {})
  }, [])

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/60 p-4">
        <div className="mb-8">
          <h1 className="text-lg font-semibold tracking-tight text-zinc-100">
            ArrLink
          </h1>
          <p className="text-xs text-zinc-500">tag-based hardlinks</p>
        </div>
        <nav className="space-y-1">
          {nav.map((i) => (
            <NavLink
              key={i.to}
              to={i.to}
              end={i.end}
              className={({ isActive }) =>
                `block rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-indigo-600/20 text-indigo-300'
                    : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
                }`
              }
            >
              {i.label}
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
              sign out
            </button>
          </div>
        )}
      </aside>
      <main className="flex-1 p-8">
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="apps" element={<Apps />} />
          <Route path="tags" element={<Tags />} />
          <Route path="rules" element={<Rules />} />
          <Route path="logs" element={<Logs />} />
          <Route path="settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  )
}
