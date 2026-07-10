import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'

export default function Settings() {
  const [all, setAll] = useState<Record<string, unknown>>({})
  const [key, setKey] = useState('')
  const [value, setValue] = useState('{}')
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setAll(await api.getSettings())
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
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch (e) {
      setErr(`Value must be valid JSON: ${e}`)
      return
    }
    try {
      setAll(await api.setSetting(key.trim(), parsed))
      setOk(`Saved "${key.trim()}"`)
      setKey('')
      setValue('{}')
    } catch (e) {
      setErr(String(e))
    }
  }

  async function remove(k: string) {
    try {
      await api.deleteSetting(k)
      setAll(await api.getSettings())
    } catch (e) {
      setErr(String(e))
    }
  }

  const keys = Object.keys(all).sort()

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Settings</h2>
        <p className="text-sm text-zinc-500">
          Runtime key/value settings (auth allow-lists, fs fallback, etc. land
          with M1/M6). Environment-level settings (auth mode, OIDC vars) are
          configured via the compose file.
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
        className="flex items-end gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
      >
        <label className="w-56 text-sm">
          <span className="mb-1 block text-zinc-400">Key</span>
          <input
            className={inputCls}
            required
            pattern="[a-z0-9_.-]{1,64}"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="oidc_allowed_groups"
          />
        </label>
        <label className="flex-1 text-sm">
          <span className="mb-1 block text-zinc-400">Value (JSON)</span>
          <input
            className={inputCls}
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder='["arrlink"]'
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
        >
          Save
        </button>
      </form>

      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2">Key</th>
              <th className="px-3 py-2">Value</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {keys.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-zinc-500">
                  No settings yet.
                </td>
              </tr>
            )}
            {keys.map((k) => (
              <tr key={k} className="bg-zinc-950/40">
                <td className="px-3 py-2 font-mono text-xs text-zinc-300">
                  {k}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-400">
                  {JSON.stringify(all[k])}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => remove(k)}
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
