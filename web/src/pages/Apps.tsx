import { useCallback, useEffect, useState } from 'react'
import AppModal from '../components/AppModal'
import { api, fmtTime, type AppItem } from '../lib/api'

/**
 * Apps (M6+): create and edit Radarr/Sonarr connections. Each row can be
 * edited (name, URL, API key, poll interval, enabled), tested, have its tags
 * imported, rescanned, or deleted.
 */
export default function Apps() {
  const [apps, setApps] = useState<AppItem[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<AppItem | null>(null)
  const [rowMsg, setRowMsg] = useState<Record<number, string>>({})

  const load = useCallback(async () => {
    try {
      setApps(await api.listApps())
    } catch (e) {
      setErr(String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function openNew() {
    setEditing(null)
    setModalOpen(true)
  }

  function openEdit(a: AppItem) {
    setEditing(a)
    setModalOpen(true)
  }

  async function remove(a: AppItem) {
    if (!confirm(`Delete app "${a.name}"? Its links will be left in place.`))
      return
    try {
      await api.deleteApp(a.id)
      setOk(`Deleted app "${a.name}".`)
      await load()
    } catch (e) {
      setErr(String(e))
    }
  }

  async function testRow(id: number) {
    setRowMsg((m) => ({ ...m, [id]: 'Testing…' }))
    try {
      const r = await api.testAppId(id)
      setRowMsg((m) => ({ ...m, [id]: `ok · ${r.version}` }))
    } catch (ex) {
      setRowMsg((m) => ({ ...m, [id]: `fail: ${ex}` }))
    }
    await load()
  }

  async function importRow(id: number) {
    setRowMsg((m) => ({ ...m, [id]: 'Importing tags…' }))
    try {
      const r = await api.importTags(id)
      setRowMsg((m) => ({ ...m, [id]: `imported ${r.imported} tags` }))
    } catch (ex) {
      setRowMsg((m) => ({ ...m, [id]: `fail: ${ex}` }))
    }
    await load()
  }

  async function rescanRow(id: number) {
    setRowMsg((m) => ({ ...m, [id]: 'Scanning…' }))
    try {
      const r = await api.rescanApp(id)
      setRowMsg((m) => ({ ...m, [id]: r.ok ? 'scanned' : 'scan failed' }))
    } catch (ex) {
      setRowMsg((m) => ({ ...m, [id]: `scan failed: ${ex}` }))
    }
    await load()
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Apps</h2>
          <p className="text-sm text-zinc-500">
            Connect Radarr and Sonarr — test the connection, import tags, and
            rescan to reconcile links.
          </p>
        </div>
        <button
          onClick={openNew}
          className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
        >
          + Add app
        </button>
      </div>

      {err && (
        <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
          {err}
        </div>
      )}
      {ok && (
        <div className="rounded-md border border-emerald-900 bg-emerald-950/40 p-3 text-sm text-emerald-300">
          {ok}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">URL</th>
              <th className="px-3 py-2">API key</th>
              <th className="px-3 py-2">Poll</th>
              <th className="px-3 py-2">Last poll</th>
              <th className="px-3 py-2">Actions</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {apps.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-zinc-500">
                  No apps yet — click <span className="text-indigo-400">Add app</span>.
                </td>
              </tr>
            )}
            {apps.map((a) => (
              <tr key={a.id} className="bg-zinc-950/40">
                <td className="px-3 py-2 font-medium">
                  {a.name}
                  {!a.enabled && (
                    <span className="ml-2 text-xs text-zinc-500">(disabled)</span>
                  )}
                </td>
                <td className="px-3 py-2">{a.type}</td>
                <td className="px-3 py-2 text-zinc-400">{a.url}</td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                  {a.api_key_masked}
                </td>
                <td className="px-3 py-2">{a.poll_interval_s}s</td>
                <td className="px-3 py-2 text-zinc-400">
                  {a.last_error ? (
                    <span className="text-red-400">{a.last_error}</span>
                  ) : (
                    fmtTime(a.last_poll_at)
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => testRow(a.id)}
                      className="rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                    >
                      test
                    </button>
                    <button
                      onClick={() => importRow(a.id)}
                      className="rounded px-2 py-1 text-xs text-indigo-300 hover:bg-indigo-950/40"
                    >
                      import tags
                    </button>
                    <button
                      onClick={() => rescanRow(a.id)}
                      className="rounded px-2 py-1 text-xs text-emerald-300 hover:bg-emerald-950/40"
                    >
                      rescan
                    </button>
                    {rowMsg[a.id] && (
                      <span className="text-xs text-zinc-500">{rowMsg[a.id]}</span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => openEdit(a)}
                      className="rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                    >
                      edit
                    </button>
                    <button
                      onClick={() => void remove(a)}
                      className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-950/40"
                    >
                      delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <AppModal
          initial={editing}
          onClose={() => setModalOpen(false)}
          onSaved={() => void load()}
        />
      )}
    </div>
  )
}
