import { useCallback, useEffect, useState } from 'react'
import Modal from './Modal'
import PreviewPanel from './PreviewPanel'
import {
  api,
  type AppItem,
  type PresetItem,
  type RuleInput,
  type RuleItem,
  type TagItem,
} from '../lib/api'

const empty: RuleInput = {
  name: '',
  app_scope: null,
  match_type: 'exact',
  match_value: '',
  dir_template: '/media/movies',
  filename_template: null,
  enabled: true,
  unlink_on_mismatch: true,
  priority: 100,
}

/**
 * Create or edit a rule. Includes a "start from preset" quick-start: pick an
 * app type + base folder, choose a preset, and the form is pre-filled for
 * editing. On create, `initial` is null; on edit it is the existing rule.
 */
export default function RuleModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: RuleItem | null
  onClose: () => void
  onSaved: () => void
}) {
  const editing = initial !== null
  const [form, setForm] = useState<RuleInput>(
    initial
      ? {
          name: initial.name,
          app_scope: initial.app_scope,
          match_type: initial.match_type,
          match_value: initial.match_value,
          dir_template: initial.dir_template,
          filename_template: initial.filename_template,
          enabled: initial.enabled,
          unlink_on_mismatch: initial.unlink_on_mismatch,
          priority: initial.priority,
        }
      : empty,
  )
  const [apps, setApps] = useState<AppItem[]>([])
  const [tags, setTags] = useState<TagItem[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // preset quick-start
  const [presetType, setPresetType] = useState<'radarr' | 'sonarr'>('radarr')
  const [baseFolder, setBaseFolder] = useState('/media/movies')
  const [presets, setPresets] = useState<PresetItem[]>([])
  const [showPresets, setShowPresets] = useState(!editing)

  useEffect(() => {
    api.listApps().then(setApps).catch(() => {})
  }, [])

  const previewAppId =
    form.app_scope ?? (apps.find((a) => a.type === presetType)?.id ?? apps[0]?.id ?? null)

  const loadPresets = useCallback(() => {
    api
      .listPresets(presetType, baseFolder)
      .then((r) => setPresets(r.presets))
      .catch(() => setPresets([]))
  }, [presetType, baseFolder])

  useEffect(() => {
    if (showPresets) void loadPresets()
  }, [showPresets, loadPresets])

  useEffect(() => {
    if (form.app_scope === null) {
      setTags([])
      return
    }
    api
      .listTags(form.app_scope)
      .then(setTags)
      .catch(() => setTags([]))
  }, [form.app_scope])

  function switchPresetType(t: 'radarr' | 'sonarr') {
    setPresetType(t)
    setBaseFolder(t === 'radarr' ? '/media/movies' : '/media/tv')
  }

  function applyPreset(p: PresetItem) {
    setForm((f) => ({
      ...f,
      match_type: p.match_type,
      match_value: p.match_value,
      dir_template: p.dir_template,
    }))
    setErr(null)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    setBusy(true)
    try {
      if (editing && initial) {
        await api.updateRule(initial.id, {
          ...form,
          filename_template: form.filename_template || null,
        })
      } else {
        await api.createRule({
          ...form,
          filename_template: form.filename_template || null,
        })
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
    <Modal
      title={editing ? `Edit rule “${initial!.name}”` : 'New rule'}
      onClose={onClose}
    >
      {showPresets && (
        <div className="mb-4 rounded-md border border-indigo-500/30 bg-indigo-950/20 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-indigo-300">
              Start from a preset
            </span>
            <select
              className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
              value={presetType}
              onChange={(e) =>
                switchPresetType(e.target.value as 'radarr' | 'sonarr')
              }
            >
              <option value="radarr">radarr</option>
              <option value="sonarr">sonarr</option>
            </select>
            <input
              className="w-48 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-200"
              value={baseFolder}
              onChange={(e) => setBaseFolder(e.target.value)}
              placeholder="/media/movies"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => applyPreset(p)}
                title={p.dir_template}
                className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-200 hover:border-indigo-500 hover:text-indigo-300"
              >
                {p.name}
              </button>
            ))}
            {presets.length === 0 && (
              <span className="text-xs text-zinc-500">
                Pick an app type and base folder to see presets.
              </span>
            )}
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">
            Applying a preset fills the form below — adjust anything before
            saving.
          </p>
        </div>
      )}

      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
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
              list={
                form.match_type === 'regex'
                  ? undefined
                  : form.app_scope !== null
                    ? 'rule-tags-dl'
                    : undefined
              }
              value={form.match_value}
              onChange={(e) => setForm({ ...form, match_value: e.target.value })}
              placeholder="kids  /  ^##\s*-\s*(?P<user>.+)$"
            />
            <datalist id="rule-tags-dl">
              {tags.map((t) => (
                <option key={t.id} value={t.label} />
              ))}
            </datalist>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-400">Dir template</span>
            <input
              className={inputCls}
              required
              value={form.dir_template}
              onChange={(e) => setForm({ ...form, dir_template: e.target.value })}
              placeholder="/media/movies/{$user}"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-zinc-400">
              Filename template <span className="text-zinc-600">(optional)</span>
            </span>
            <input
              className={inputCls}
              value={form.filename_template ?? ''}
              onChange={(e) =>
                setForm({ ...form, filename_template: e.target.value || null })
              }
              placeholder="{$stem} (empty = keep source name)"
            />
          </label>
        </div>

        <div className="rounded-md border border-zinc-800/70 bg-zinc-950/40 p-3">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Live preview
          </h4>
          <PreviewPanel rule={form} appId={previewAppId} />
        </div>

        <div className="flex flex-wrap items-center gap-4">
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
              onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
            />
          </label>
        </div>

        {err && (
          <div className="rounded-md border border-red-900 bg-red-950/40 p-2 text-sm text-red-300">
            {err}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowPresets((s) => !s)}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
          >
            {showPresets ? 'Hide presets' : 'Show presets'}
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
              {busy ? 'Saving…' : editing ? 'Save rule' : 'Create rule'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  )
}

const inputCls =
  'w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-indigo-500'
