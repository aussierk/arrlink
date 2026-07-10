import { useCallback, useEffect, useState } from 'react'
import { api, type AppItem, type RuleInput, type RuleItem } from '../lib/api'

const empty: RuleInput = {
  name: '',
  app_scope: null,
  match_type: 'exact',
  match_value: '',
  dir_template: '/linked/movies',
  filename_template: null,
  enabled: true,
  unlink_on_mismatch: true,
  priority: 100,
}

export default function Rules() {
  const [rules, setRules] = useState<RuleItem[]>([])
  const [apps, setApps] = useState<AppItem[]>([])
  const [form, setForm] = useState<RuleInput>(empty)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [r, a] = await Promise.all([api.listRules(), api.listApps()])
      setRules(r)
      setApps(a)
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
      const r = await api.createRule({
        ...form,
        filename_template: form.filename_template || null,
      })
      setOk(`Added rule "${r.name}" — live preview lands in M3`)
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
      await api.deleteRule(id)
      await load()
    } catch (e) {
      setErr(String(e))
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Rules</h2>
        <p className="text-sm text-zinc-500">
          Tag matchers → destination templates. Matching + dry-run preview
          arrive in M3; presets in M6.
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
        className="grid grid-cols-4 gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
      >
        <label className="text-sm">
          <span className="mb-1 block text-zinc-400">Name</span>
          <input
            className={inputCls}
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="user tags"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-400">App scope</span>
          <select
            className={inputCls}
            value={form.app_scope === null ? '' : String(form.app_scope)}
            onChange={(e) =>
              setForm({
                ...form,
                app_scope: e.target.value === '' ? null : Number(e.target.value),
              })
            }
          >
            <option value="">any app</option>
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.type})
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-400">Match type</span>
          <select
            className={inputCls}
            value={form.match_type}
            onChange={(e) =>
              setForm({
                ...form,
                match_type: e.target.value as RuleInput['match_type'],
              })
            }
          >
            <option value="exact">exact</option>
            <option value="list">list</option>
            <option value="regex">regex</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-zinc-400">Match value</span>
          <input
            className={inputCls}
            required
            value={form.match_value}
            onChange={(e) => setForm({ ...form, match_value: e.target.value })}
            placeholder="## - alice  /  ^##\s*-\s*(?P<user>.+)$"
          />
        </label>
        <label className="col-span-2 text-sm">
          <span className="mb-1 block text-zinc-400">Dir template</span>
          <input
            className={inputCls}
            required
            value={form.dir_template}
            onChange={(e) => setForm({ ...form, dir_template: e.target.value })}
            placeholder="/linked/movies/users/{$user}"
          />
        </label>
        <label className="col-span-2 text-sm">
          <span className="mb-1 block text-zinc-400">
            Filename template <span className="text-zinc-600">(optional)</span>
          </span>
          <input
            className={inputCls}
            value={form.filename_template ?? ''}
            onChange={(e) =>
              setForm({
                ...form,
                filename_template: e.target.value || null,
              })
            }
            placeholder="{$stem} (empty = keep source name)"
          />
        </label>
        <div className="col-span-4 flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            enabled
          </label>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input
              type="checkbox"
              checked={form.unlink_on_mismatch}
              onChange={(e) =>
                setForm({ ...form, unlink_on_mismatch: e.target.checked })
              }
            />
            unlink on mismatch
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-400">Priority</span>
            <input
              className={inputCls}
              type="number"
              min={1}
              max={1000}
              value={form.priority}
              onChange={(e) =>
                setForm({ ...form, priority: Number(e.target.value) })
              }
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="ml-auto rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {busy ? 'Adding…' : 'Add rule'}
          </button>
        </div>
      </form>

      <div className="overflow-hidden rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">App</th>
              <th className="px-3 py-2">Match</th>
              <th className="px-3 py-2">Dir template</th>
              <th className="px-3 py-2">Filename</th>
              <th className="px-3 py-2">Flags</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {rules.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-zinc-500">
                  No rules yet.
                </td>
              </tr>
            )}
            {rules.map((r) => (
              <tr key={r.id} className="bg-zinc-950/40">
                <td className="px-3 py-2 font-medium">
                  {r.name}
                  {!r.enabled && (
                    <span className="ml-2 text-xs text-zinc-500">(off)</span>
                  )}
                </td>
                <td className="px-3 py-2 text-zinc-400">
                  {r.app_name ?? 'any'}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-300">
                  {r.match_type}:{' '}
                  <span className="break-all">{r.match_value}</span>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-300">
                  {r.dir_template}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                  {r.filename_template ?? '(source)'}
                </td>
                <td className="px-3 py-2 text-xs text-zinc-400">
                  p{r.priority}
                  {r.unlink_on_mismatch ? ' · unlink' : ''}
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => remove(r.id)}
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
