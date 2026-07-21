import { useCallback, useEffect, useState } from 'react'
import { api, fmtTime, type AppInput, type AppItem } from '../lib/api'

const empty: AppInput = {
  name: '',
  type: 'radarr',
  url: '',
  api_key: '',
  enabled: true,
  poll_interval_s: 30,
}

export default function Apps() {
  const [apps, setApps] = useState<AppItem[]>([])
  const [form, setForm] = useState<AppInput>(empty)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
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

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    setOk(null)
    setBusy(true)
    try {
      const a = await api.createApp(form)
      setOk(`Added "${a.name}"`)
      setForm(empty)
      await load()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: number) {
    try {
      await api.deleteApp(id)
      await load()
    } catch (e) {
      setErr(String(e))
    }
  }

  async function testForm(e: React.MouseEvent) {
    e.preventDefault()
    setTesting(true)
    setErr(null)
    setTestResult(null)
    try {
      const r = await api.testApp(form)
      setTestResult(`Connected — ${r.name} ${r.version}`)
    } catch (ex) {
      setTestResult(`Failed: ${ex}`)
    } finally {
      setTesting(false)
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
      <div>
        <h2 className="text-xl font-semibold">Apps</h2>
        <p className="text-sm text-zinc-500">
          Connect Radarr / Sonarr. Connection tests + tag import arrive in M2.
        </p>
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

      <form
        onSubmit={submit}
        className="grid grid-cols-6 gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
      >
        <label className="col-span-2 text-sm">
          <span className="mb-1 block text-zinc-400">Name</span>
          <input
            className={inputCls}
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="My Radarr"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-400">Type</span>
          <select
            className={inputCls}
            value={form.type}
            onChange={(e) =>
              setForm({ ...form, type: e.target.value as AppInput['type'] })
            }
          >
            <option value="radarr">radarr</option>
            <option value="sonarr">sonarr</option>
          </select>
        </label>
        <label className="col-span-2 text-sm">
          <span className="mb-1 block text-zinc-400">URL</span>
          <input
            className={inputCls}
            required
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            placeholder="http://host:7878"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-400">API key</span>
          <input
            className={inputCls}
            required
            type="password"
            value={form.api_key}
            onChange={(e) => setForm({ ...form, api_key: e.target.value })}
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-400">Poll (s)</span>
          <input
            className={inputCls}
            type="number"
            min={10}
            max={600}
            value={form.poll_interval_s}
            onChange={(e) =>
              setForm({ ...form, poll_interval_s: Number(e.target.value) })
            }
          />
        </label>
        <div className="col-span-6 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            enabled
          </label>
          {testResult && (
            <span
              className={`text-xs ${testResult.startsWith('Connected') ? 'text-emerald-400' : 'text-red-400'}`}>
              {testResult}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={testForm}
              disabled={testing || !form.url || !form.api_key}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
            >
              {testing ? 'Testing…' : 'Test'}
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {busy ? 'Adding…' : 'Add app'}
            </button>
          </div>
        </div>
      </form>

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
                  No apps yet.
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
                  <button
                    onClick={() => remove(a.id)}
                    className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-950/40"
                  >
                    delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const inputCls =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500'
