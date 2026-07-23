import { useCallback, useEffect, useState } from 'react'
import PreviewPanel from '../components/PreviewPanel'
import RuleModal from '../components/RuleModal'
import {
  api,
  type AppItem,
  type RuleItem,
} from '../lib/api'

/**
 * Rules: the single place to build and edit rules. "Add rule" opens the
 * rule modal, which includes a "start from a preset" quick-start. Each row can
 * be edited, previewed, or deleted.
 */
export default function Rules() {
  const [rules, setRules] = useState<RuleItem[]>([])
  const [apps, setApps] = useState<AppItem[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<RuleItem | null>(null)
  const [previewFor, setPreviewFor] = useState<RuleItem | null>(null)

  const previewAppId = (r: { app_scope: number | null }) =>
    r.app_scope ??
    (apps.find((a) => a.id === r.app_scope)?.id ?? apps[0]?.id ?? null)

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

  function openNew() {
    setEditing(null)
    setModalOpen(true)
  }

  function openEdit(r: RuleItem) {
    setEditing(r)
    setModalOpen(true)
  }

  async function remove(r: RuleItem) {
    const links = await api
      .listLinks({ rule_id: r.id, status: 'active' })
      .catch(() => [] as { id: number }[])
    const msg =
      links.length > 0
        ? `Delete rule "${r.name}" and its ${links.length} active link(s)?`
        : `Delete rule "${r.name}"?`
    if (!confirm(msg)) return
    try {
      await api.deleteRule(r.id)
      setOk(`Deleted rule "${r.name}".`)
      await load()
    } catch (e) {
      setErr(String(e))
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Rules</h2>
          <p className="text-sm text-zinc-500">
            Tag matchers → destination templates. Build from a{' '}
            <span className="text-indigo-400">preset</span> or from scratch; the
            live preview shows exactly what would be hardlinked.
          </p>
        </div>
        <button
          onClick={openNew}
          className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
        >
          + Add rule
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
              <th className="px-3 py-2">App</th>
              <th className="px-3 py-2">Match</th>
              <th className="px-3 py-2">Dir template</th>
              <th className="px-3 py-2">Filename</th>
              <th className="px-3 py-2">Flags</th>
              <th className="px-3 py-2">Preview</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {rules.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-zinc-500">
                  No rules yet — click <span className="text-indigo-400">Add rule</span>{' '}
                  and start from a preset.
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
                <td className="px-3 py-2">
                  <button
                    onClick={() =>
                      setPreviewFor(previewFor?.id === r.id ? null : r)
                    }
                    className="rounded px-2 py-1 text-xs text-indigo-300 hover:bg-indigo-950/40"
                  >
                    {previewFor?.id === r.id ? 'hide' : 'preview'}
                  </button>
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => openEdit(r)}
                      className="rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                    >
                      edit
                    </button>
                    <button
                      onClick={() => void remove(r)}
                      className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-950/40"
                    >
                      delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {previewFor && (
              <tr className="bg-zinc-900/40">
                <td colSpan={8} className="px-3 py-3">
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                    Preview — {previewFor.name}
                  </h4>
                  <PreviewPanel
                    rule={{
                      name: previewFor.name,
                      app_scope: previewFor.app_scope,
                      match_type: previewFor.match_type,
                      match_value: previewFor.match_value,
                      dir_template: previewFor.dir_template,
                      filename_template: previewFor.filename_template,
                      enabled: previewFor.enabled,
                      unlink_on_mismatch: previewFor.unlink_on_mismatch,
                      priority: previewFor.priority,
                    }}
                    appId={previewAppId(previewFor)}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-zinc-600">
        Presets are a quick-start inside the rule form. Manage the shared tag
        repository on the Tags page.
      </p>

      {modalOpen && (
        <RuleModal
          initial={editing}
          onClose={() => setModalOpen(false)}
          onSaved={() => void load()}
        />
      )}
    </div>
  )
}
