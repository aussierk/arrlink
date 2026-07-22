import { useState } from 'react'
import Modal from './Modal'
import { api, DEFAULT_POLL_INTERVAL_S, type AppInput, type AppItem } from '../lib/api'

/**
 * Create or edit an app. On create, `initial` is empty; on edit it is the
 * existing app (API key masked — leave blank to keep the current key).
 */
export default function AppModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: AppItem | null
  onClose: () => void
  onSaved: () => void
}) {
  const editing = initial !== null
  const [form, setForm] = useState<AppInput>(
    initial
      ? {
          name: initial.name,
          type: initial.type,
          url: initial.url,
          api_key: '',
          enabled: initial.enabled,
          poll_interval_s: initial.poll_interval_s,
        }
      : {
          name: '',
          type: 'radarr',
          url: '',
          api_key: '',
          enabled: true,
          poll_interval_s: DEFAULT_POLL_INTERVAL_S,
        },
  )
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function test() {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api.testApp({ ...form, api_key: form.api_key || 'x' })
      setTestResult(`Connected — ${r.name} ${r.version}`)
    } catch (e) {
      setTestResult(`Failed: ${e}`)
    } finally {
      setTesting(false)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      if (editing && initial) {
        // API key blank = keep the existing key (sent empty; backend preserves it)
        await api.updateApp(initial.id, form)
      } else {
        await api.createApp(form)
      }
      onSaved()
      onClose()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={editing ? `Edit ${initial!.name}` : 'Add app'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
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
              disabled={editing}
              onChange={(e) =>
                setForm({ ...form, type: e.target.value as AppInput['type'] })
              }
            >
              <option value="radarr">radarr</option>
              <option value="sonarr">sonarr</option>
            </select>
          </label>
          <label className="text-sm">
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
            <span className="mb-1 block text-zinc-400">
              API key{editing && <span className="text-zinc-600"> (blank = keep current)</span>}
            </span>
            <input
              className={inputCls}
              type="password"
              required={!editing}
              value={form.api_key}
              onChange={(e) => setForm({ ...form, api_key: e.target.value })}
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-400">Poll interval (s)</span>
            <input
              className={inputCls}
              type="number"
              min={10}
              max={3600}
              value={form.poll_interval_s}
              onChange={(e) =>
                setForm({ ...form, poll_interval_s: Number(e.target.value) })
              }
            />
          </label>
          <label className="flex items-end gap-2 pb-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            enabled
          </label>
        </div>

        {testResult && (
          <p
            className={`text-xs ${testResult.startsWith('Connected') ? 'text-emerald-400' : 'text-red-400'}`}
          >
            {testResult}
          </p>
        )}
        {err && (
          <div className="rounded-md border border-red-900 bg-red-950/40 p-2 text-sm text-red-300">
            {err}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void test()}
            disabled={testing || !form.url || !form.api_key}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Add app'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

const inputCls =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500'
