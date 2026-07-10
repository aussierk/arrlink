import { useCallback, useEffect, useState } from 'react'
import { api, fmtTime, type AppItem, type Health, type Me } from '../lib/api'

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [apps, setApps] = useState<AppItem[]>([])
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [h, m, a] = await Promise.all([api.health(), api.me(), api.listApps()])
      setHealth(h)
      setMe(m)
      setApps(a)
    } catch (e) {
      setErr(String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Dashboard</h2>
        <p className="text-sm text-zinc-500">
          M0 scaffold — connection checks, tag import, and hardlinking land in
          later milestones.
        </p>
      </div>

      {err && (
        <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
          {err}
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <Card title="Status">
          {health ? (
            <div className="space-y-1 text-sm">
              <p>
                <span
                  className={
                    health.status === 'ok'
                      ? 'text-emerald-400'
                      : 'text-red-400'
                }>
                  ● {health.status}
                </span>
              </p>
              <p className="text-zinc-400">version {health.version}</p>
              <p className="text-zinc-400">schema v{health.schema_version}</p>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">loading…</p>
          )}
        </Card>
        <Card title="Auth">
          {me ? (
            <div className="space-y-1 text-sm">
              <p className="text-zinc-300">mode: {me.auth_mode}</p>
              <p className="text-zinc-500">
                {me.authenticated
                  ? 'signed in'
                  : 'OIDC auto-login arrives in M1'}
              </p>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">loading…</p>
          )}
        </Card>
        <Card title="Apps">
          <p className="text-2xl font-semibold">{apps.length}</p>
          <p className="text-sm text-zinc-500">
            {apps.length === 1 ? 'app connected' : 'apps connected'}
          </p>
        </Card>
      </div>

      <Card title="Connected apps">
        {apps.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No apps yet — add Radarr or Sonarr on the Apps page.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-800">
            {apps.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2 text-sm">
                <span
                  className={
                    a.type === 'radarr'
                      ? 'rounded bg-rose-600/20 px-2 py-0.5 text-xs text-rose-300'
                      : 'rounded bg-sky-600/20 px-2 py-0.5 text-xs text-sky-300'
                  }
                >
                  {a.type}
                </span>
                <span className="font-medium">{a.name}</span>
                <span className="text-zinc-500">{a.url}</span>
                <span className="ml-auto text-zinc-500">
                  last poll: {fmtTime(a.last_poll_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function Card({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {title}
      </h3>
      {children}
    </div>
  )
}
