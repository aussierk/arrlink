import { useCallback, useEffect, useMemo, useState } from 'react'
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
import {
  LIST_GROUPS,
  REGEX_PICKS,
  joinList,
  parseList,
} from '../lib/tagOptions'

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

const CUSTOM = '__custom__'

/**
 * Create or edit a rule. The match is entered ergonomically instead of as raw
 * text: a type (exact / list / regex) plus, for each type, dropdowns and a
 * multi-select of common tag formats. The underlying exact / list / regex
 * match_value is unchanged — the UI just parses/renders it against the common
 * formats. Includes a "start from preset" quick-start and a live preview.
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
  const [customTag, setCustomTag] = useState('')

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

  // ---- match helpers -------------------------------------------------------
  const valueTags = useMemo(
    () => (form.match_type === 'list' ? parseList(form.match_value) : []),
    [form.match_type, form.match_value],
  )

  // exact: dropdown of app tags + common single values; CUSTOM if not in list
  const exactOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    const push = (v: string) => {
      if (v && !seen.has(v)) {
        seen.add(v)
        out.push(v)
      }
    }
    tags.forEach((t) => push(t.label))
    LIST_GROUPS.forEach((g) => g.tags.forEach(push))
    return out
  }, [tags])
  const exactIsCustom =
    !!form.match_value && !exactOptions.includes(form.match_value)

  // regex: dropdown of common patterns; CUSTOM if the value isn't a known pick
  const regexPick = REGEX_PICKS.find((p) => p.pattern === form.match_value)
  const regexIsCustom = !!form.match_value && !regexPick
  const selectedPickHint = regexPick?.hint

  function setMatchType(t: RuleInput['match_type']) {
    setForm((f) => ({ ...f, match_type: t, match_value: '' }))
    setErr(null)
  }
  function setExact(v: string) {
    setForm((f) => ({ ...f, match_value: v }))
    setErr(null)
  }
  function toggleListTag(tag: string) {
    const cur = parseList(form.match_value)
    const next = cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]
    setForm((f) => ({ ...f, match_value: joinList(next) }))
    setErr(null)
  }
  function addCustomTag() {
    const v = customTag.trim()
    if (!v) return
    if (!valueTags.includes(v)) toggleListTag(v)
    setCustomTag('')
  }
  function setRegex(v: string) {
    setForm((f) => ({ ...f, match_value: v }))
    setErr(null)
  }

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
    if (!form.match_value.trim()) {
      setErr('Pick at least one match value.')
      return
    }
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

  // checkbox groups for the list multi-select: app tags + common groups, plus
  // any already-selected tags that aren't in a known group (custom values).
  const listGroups = useMemo(() => {
    const known = new Set<string>()
    LIST_GROUPS.forEach((g) => g.tags.forEach((t) => known.add(t)))
    const appTags = tags
      .map((t) => t.label)
      .filter((t) => !known.has(t))
    const other = valueTags.filter((t) => !known.has(t) && !appTags.includes(t))
    const groups: { group: string; tags: string[] }[] = []
    if (appTags.length) groups.push({ group: 'App tags', tags: appTags })
    LIST_GROUPS.forEach((g) => groups.push({ group: g.group, tags: g.tags }))
    if (other.length) groups.push({ group: 'Selected / other', tags: other })
    return groups
  }, [tags, valueTags])

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
        </div>

        {/* Match: type + ergonomic value editor */}
        <div className="rounded-md border border-zinc-800/70 bg-zinc-950/40 p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Match
            </span>
            <div className="flex rounded-md border border-zinc-700 p-0.5 text-xs">
              {(['exact', 'list', 'regex'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setMatchType(t)}
                  className={`rounded px-2.5 py-1 ${
                    form.match_type === t
                      ? 'bg-indigo-600 text-white'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {form.match_type === 'exact' && (
            <div className="space-y-2">
              <select
                className={inputCls}
                value={exactIsCustom ? CUSTOM : form.match_value}
                onChange={(e) => {
                  const v = e.target.value
                  setExact(v === CUSTOM ? (form.match_value || '') : v)
                }}
              >
                <option value="">Select a tag…</option>
                {exactOptions.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
                <option value={CUSTOM}>Custom…</option>
              </select>
              {exactIsCustom && (
                <input
                  className={inputCls}
                  value={form.match_value}
                  onChange={(e) => setExact(e.target.value)}
                  placeholder="exact tag to match"
                />
              )}
              <p className="text-[11px] text-zinc-500">
                Matches an item that has this exact tag.
              </p>
            </div>
          )}

          {form.match_type === 'list' && (
            <div className="space-y-3">
              {listGroups.map((g) => (
                <div key={g.group}>
                  <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                    {g.group}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {g.tags.map((t) => {
                      const on = valueTags.includes(t)
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() => toggleListTag(t)}
                          className={`rounded-full border px-2.5 py-0.5 text-xs ${
                            on
                              ? 'border-indigo-500 bg-indigo-600/20 text-indigo-200'
                              : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:border-zinc-500'
                          }`}
                        >
                          {on ? '✓ ' : ''}
                          {t}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
              <div className="flex items-center gap-2">
                <input
                  className={inputCls + ' flex-1'}
                  value={customTag}
                  onChange={(e) => setCustomTag(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addCustomTag()
                    }
                  }}
                  placeholder="add a custom tag…"
                />
                <button
                  type="button"
                  onClick={addCustomTag}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  Add
                </button>
              </div>
              <p className="text-[11px] text-zinc-500">
                Matches an item that has any selected tag.{' '}
                <span className="text-zinc-400">{valueTags.length} selected.</span>
              </p>
            </div>
          )}

          {form.match_type === 'regex' && (
            <div className="space-y-2">
              <select
                className={inputCls}
                value={regexIsCustom ? CUSTOM : regexPick?.pattern ?? ''}
                onChange={(e) => {
                  const v = e.target.value
                  setRegex(v === CUSTOM ? (form.match_value || '') : v)
                }}
              >
                <option value="">Select a pattern…</option>
                {REGEX_PICKS.map((p) => (
                  <option key={p.pattern} value={p.pattern}>
                    {p.label}
                  </option>
                ))}
                <option value={CUSTOM}>Custom regex…</option>
              </select>
              {selectedPickHint && (
                <p className="text-[11px] text-zinc-500">{selectedPickHint}</p>
              )}
              {regexIsCustom && (
                <textarea
                  className={inputCls + ' font-mono'}
                  rows={2}
                  value={form.match_value}
                  onChange={(e) => setRegex(e.target.value)}
                  placeholder="^##\s*-\s*(?P<user>.+)$"
                />
              )}
              <p className="text-[11px] text-zinc-500">
                Pick a common pattern (e.g. “## - username”) or write your own.
              </p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3">
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
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
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
