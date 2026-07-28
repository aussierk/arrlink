import { useEffect, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Sparkles, Trash2 } from 'lucide-react'
import i18n from '../i18n'
import Modal from './Modal'
import PreviewPanel from './PreviewPanel'
import Toggle from './ui/Toggle'
import TagSelect from './ui/TagSelect'
import Field from './ui/Field'
import {
  api,
  type AppItem,
  type ConditionCategory,
  type ConditionItem,
  type PresetItem,
  type RuleInput,
  type RuleItem,
  type TagItem,
} from '../lib/api'
import {
  CUSTOM_TAG_SUGGESTIONS,
  LANGUAGE_TAGS,
  QUALITY_PROFILE_TAGS,
  REGEX_PICKS,
  COLLECTION_TAGS,
  certificationTagsFor,
  genreTagsFor,
  joinList,
  parseList,
  type ServiceType,
} from '../lib/tagOptions'
import { inputCls } from '../lib/ui'

const CUSTOM = '__custom__'

const CATEGORY_ORDER: ConditionCategory[] = [
  'user', 'genre', 'language', 'quality', 'certification', 'collection', 'custom',
]

const CATEGORY_LABEL_KEY: Record<string, string> = {
  user: 'ruleModal.categoryLabel.user',
  genre: 'ruleModal.categoryLabel.genre',
  language: 'ruleModal.categoryLabel.language',
  quality: 'ruleModal.categoryLabel.quality',
  certification: 'ruleModal.categoryLabel.certification',
  collection: 'ruleModal.categoryLabel.collection',
  custom: 'ruleModal.categoryLabel.custom',
  legacy: 'ruleModal.categoryLabel.legacy',
}

function categoryLabel(cat: string): string {
  const key = CATEGORY_LABEL_KEY[cat]
  return key ? i18n.t(key) : cat
}

type FormState = Omit<RuleInput, 'conditions'>

const emptyForm: FormState = {
  name: '',
  app_scope: null,
  app_type_scope: null,
  dir_template: '/media/movies',
  filename_template: null,
  enabled: true,
  unlink_on_mismatch: true,
  priority: 100,
}

// The Service <select> encodes three kinds of scope in one string value:
// '' (any service), 'type:radarr' / 'type:sonarr' (all instances of that
// type), or a specific app's id — decoded back into the two real fields.
function encodeServiceValue(appScope: number | null, appTypeScope: string | null): string {
  if (appTypeScope) return `type:${appTypeScope}`
  return appScope === null ? '' : String(appScope)
}

function selectedFor(c: ConditionItem): string[] {
  if (c.match_type === 'list') return parseList(c.match_value)
  return c.match_value ? [c.match_value] : []
}

/**
 * Create or edit a rule. Conditions are an ordered AND/OR chain: each
 * condition is tied to exactly one category (Users, Genres, Languages,
 * Quality Profile, Certification, Collections, Custom tags) with its own
 * match type (exact/list/regex). Evaluated left-to-right with standard
 * short-circuit semantics — only conditions that actually matched feed
 * their category's placeholder (e.g. {$genre}) into the destination
 * template. A specific Service must be picked first since Genre/
 * Certification suggestions depend on its type (movie vs TV).
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
  const { t } = useTranslation()
  const editing = initial !== null
  const [form, setForm] = useState<FormState>(
    initial
      ? {
          name: initial.name,
          app_scope: initial.app_scope,
          app_type_scope: initial.app_type_scope,
          dir_template: initial.dir_template,
          filename_template: initial.filename_template,
          enabled: initial.enabled,
          unlink_on_mismatch: initial.unlink_on_mismatch,
          priority: initial.priority,
        }
      : emptyForm,
  )
  const [conditions, setConditions] = useState<ConditionItem[]>(
    initial ? initial.conditions : [],
  )

  const [apps, setApps] = useState<AppItem[]>([])
  const [tags, setTags] = useState<TagItem[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [presets, setPresets] = useState<PresetItem[]>([])

  useEffect(() => {
    api.listApps().then(setApps).catch(() => {})
  }, [])

  const selectedApp = apps.find((a) => a.id === form.app_scope)
  // A specific instance pins the type directly; a type-scope ("All Radarr")
  // pins it just as definitely, just without one specific app.
  const serviceType: ServiceType =
    (selectedApp?.type as ServiceType) ?? (form.app_type_scope as ServiceType) ?? 'radarr'
  // One concrete app to fetch tag suggestions / run Live Preview against:
  // the specific instance if chosen, else the first app matching the
  // type-scope, else (unscoped) whatever's first.
  const representativeAppId =
    form.app_scope ?? apps.find((a) => a.type === form.app_type_scope)?.id ?? null
  const previewAppId = representativeAppId ?? apps[0]?.id ?? null

  useEffect(() => {
    api
      .listPresets(serviceType)
      .then((r) => setPresets(r.presets))
      .catch(() => setPresets([]))
  }, [serviceType])

  useEffect(() => {
    if (representativeAppId === null) {
      setTags([])
      return
    }
    api
      .listTags(representativeAppId)
      .then(setTags)
      .catch(() => setTags([]))
  }, [representativeAppId])

  const knownTags = useMemo(
    () =>
      new Set([
        ...genreTagsFor(serviceType),
        ...certificationTagsFor(serviceType),
        ...LANGUAGE_TAGS,
        ...QUALITY_PROFILE_TAGS,
      ]),
    [serviceType],
  )
  const customOptions = useMemo(() => {
    const appTags = tags.map((t) => t.label).filter((l) => !knownTags.has(l))
    const extra = CUSTOM_TAG_SUGGESTIONS.filter((t) => !knownTags.has(t))
    return Array.from(new Set([...appTags, ...extra]))
  }, [tags, knownTags])

  // renderConditionValue only ever calls these for the modern (non-legacy)
  // condition blocks — a legacy-category condition renders via its own
  // dedicated block above and never reaches here — but ConditionItem's
  // category is typed to include 'legacy' for round-tripping, so these
  // accept the wider type to stay assignable from c.category.
  function optionsFor(category: ConditionCategory | 'legacy'): string[] {
    switch (category) {
      case 'genre':
        return genreTagsFor(serviceType)
      case 'certification':
        return certificationTagsFor(serviceType)
      case 'language':
        return LANGUAGE_TAGS
      case 'quality':
        return QUALITY_PROFILE_TAGS
      case 'collection':
        return COLLECTION_TAGS
      case 'custom':
        return customOptions
      case 'user':
      case 'legacy':
        return []
    }
  }

  function creatableFor(category: ConditionCategory | 'legacy', matchType: ConditionItem['match_type']) {
    if (matchType === 'regex') return true
    return category === 'collection' || category === 'custom' || category === 'user'
  }

  function updateBlock(i: number, patch: Partial<ConditionItem>) {
    setConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
  }

  function toggleJoin(i: number) {
    setConditions((cs) =>
      cs.map((c, idx) => (idx === i ? { ...c, join: c.join === 'AND' ? 'OR' : 'AND' } : c)),
    )
  }

  function applyBlockSelection(i: number, prevSelected: string[], next: string[]) {
    const c = conditions[i]
    if (c.match_type !== 'list') {
      updateBlock(i, { match_value: next[0] ?? '' })
      return
    }
    const removed = prevSelected.filter((t) => !next.includes(t))
    const added = next.filter((t) => !prevSelected.includes(t))
    const cur = parseList(c.match_value).filter((t) => !removed.includes(t))
    added.forEach((t) => {
      if (!cur.includes(t)) cur.push(t)
    })
    updateBlock(i, { match_value: joinList(cur) })
  }

  function addCondition(join: 'AND' | 'OR' | null) {
    const used = new Set(conditions.map((c) => c.category))
    const next = CATEGORY_ORDER.find((cat) => !used.has(cat))
    if (!next) return
    const block: ConditionItem = {
      category: next,
      match_type: next === 'user' ? 'regex' : 'list',
      match_value: '',
      join: conditions.length === 0 ? null : join,
    }
    const updated = [...conditions, block]
    setConditions(updated)
  }

  function removeCondition(i: number) {
    if (conditions.length <= 1) return
    const next = conditions
      .filter((_, idx) => idx !== i)
      .map((c, idx) => (idx === 0 ? { ...c, join: null } : c))
    setConditions(next)
  }

  function applyPreset(p: PresetItem) {
    const idx = conditions.findIndex((c) => c.category === p.category)
    if (idx === -1) {
      const join: 'AND' | 'OR' | null = conditions.length === 0 ? null : 'OR'
      const next = [
        ...conditions,
        { category: p.category, match_type: p.match_type, match_value: p.match_value, join },
      ]
      setConditions(next)
    } else {
      const next = conditions.map((c, i) =>
        i === idx ? { ...c, match_type: p.match_type, match_value: p.match_value } : c,
      )
      setConditions(next)
    }
    setForm((f) => ({ ...f, dir_template: p.dir_template }))
    setErr(null)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr(null)
    if (conditions.length === 0) {
      setErr(t('ruleModal.addConditionErr'))
      return
    }
    if (conditions.some((c) => !c.match_value.trim())) {
      setErr(t('ruleModal.conditionValueErr'))
      return
    }
    setBusy(true)
    try {
      const body: RuleInput = {
        ...form,
        filename_template: form.filename_template || null,
        conditions: conditions.map((c, i) => ({ ...c, join: i === 0 ? null : c.join })),
      }
      if (editing && initial) {
        await api.updateRule(initial.id, body)
      } else {
        await api.createRule(body)
      }
      onSaved()
      onClose()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  const isLegacyFirst = conditions[0]?.category === 'legacy'
  const usedCategories = new Set(conditions.map((c) => c.category))
  const allCategoriesUsed = CATEGORY_ORDER.every((cat) => usedCategories.has(cat))
  const previewRule: RuleInput = { ...form, conditions }

  function renderConditionValue(i: number) {
    const c = conditions[i]
    const selected = selectedFor(c)

    if (c.category === 'user' && c.match_type === 'regex') {
      const regexPick = REGEX_PICKS.find((p) => p.pattern === c.match_value)
      const regexIsCustom = !!c.match_value && !regexPick
      return (
        <div className="space-y-2">
          <select
            className={inputCls}
            value={regexIsCustom ? CUSTOM : regexPick?.pattern ?? ''}
            onChange={(e) => {
              const v = e.target.value
              updateBlock(i, { match_value: v === CUSTOM ? c.match_value || '' : v })
            }}
          >
            <option value="">{t('ruleModal.selectPattern')}</option>
            {REGEX_PICKS.map((p) => (
              <option key={p.pattern} value={p.pattern}>
                {p.label}
              </option>
            ))}
            <option value={CUSTOM}>{t('ruleModal.customRegex')}</option>
          </select>
          {regexPick?.hint && <p className="text-[11px] text-zinc-500">{regexPick.hint}</p>}
          {regexIsCustom && (
            <textarea
              className={inputCls + ' font-mono'}
              rows={2}
              value={c.match_value}
              onChange={(e) => updateBlock(i, { match_value: e.target.value })}
              placeholder={t('ruleModal.customRegexPlaceholder')}
            />
          )}
        </div>
      )
    }

    return (
      <TagSelect
        placeholder={
          c.match_type === 'regex'
            ? t('ruleModal.pickOrTypePattern')
            : t('ruleModal.selectCategoryPlaceholder', { category: categoryLabel(c.category).toLowerCase() })
        }
        options={optionsFor(c.category)}
        selected={selected}
        onChange={(next) => applyBlockSelection(i, selected, next)}
        multiple={c.match_type === 'list'}
        creatable={creatableFor(c.category, c.match_type)}
        searchPlaceholder={c.match_type === 'regex' ? t('ruleModal.searchOrTypePattern') : t('ruleModal.searchOrAdd')}
      />
    )
  }

  return (
    <Modal
      title={editing ? t('ruleModal.editTitle', { name: initial!.name }) : t('ruleModal.newTitle')}
      onClose={onClose}
      size="xl"
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('ruleModal.name')}>
          <input
            className={inputCls}
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={t('ruleModal.namePlaceholder')}
          />
        </Field>

        <Field label={t('ruleModal.service')}>
          <select
            className={inputCls}
            value={encodeServiceValue(form.app_scope, form.app_type_scope)}
            onChange={(e) => {
              const v = e.target.value
              if (v === '') {
                setForm({ ...form, app_scope: null, app_type_scope: null })
              } else if (v.startsWith('type:')) {
                setForm({
                  ...form,
                  app_scope: null,
                  app_type_scope: v.slice('type:'.length) as 'radarr' | 'sonarr',
                })
              } else {
                setForm({ ...form, app_scope: Number(v), app_type_scope: null })
              }
            }}
          >
            <option value="">{t('ruleModal.anyService')}</option>
            {apps.some((a) => a.type === 'radarr') && (
              <option value="type:radarr">{t('ruleModal.allRadarr')}</option>
            )}
            {apps.some((a) => a.type === 'sonarr') && (
              <option value="type:sonarr">{t('ruleModal.allSonarr')}</option>
            )}
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.type})
              </option>
            ))}
          </select>
        </Field>

        {(form.app_scope !== null || form.app_type_scope !== null) && (
          <div className="rounded-md border border-indigo-500/30 bg-indigo-950/20 p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-indigo-300">
              <Sparkles className="size-3.5" />
              {t('ruleModal.startFromPreset')}
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
                <span className="text-xs text-zinc-500">{t('ruleModal.noPresets')}</span>
              )}
            </div>
            <p className="mt-2 text-[11px] text-zinc-500">
              {t('ruleModal.presetHint')}
            </p>
          </div>
        )}

        <div className="space-y-3 border-t border-zinc-800 pt-4">
          <div>
            <h3 className="text-sm font-semibold text-zinc-200">{t('ruleModal.conditions')}</h3>
            <p className="text-xs text-zinc-500">
              <Trans
                i18nKey="ruleModal.conditionsHintChain"
                components={[<span className="font-mono text-zinc-400" key="genre" />]}
              />
            </p>
          </div>

          {isLegacyFirst ? (
            <div className="rounded-md border border-zinc-800/70 bg-zinc-950/40 p-3">
              <p className="mb-2 text-xs font-semibold text-zinc-400">
                {t('ruleModal.legacyHeading')}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Field label={t('ruleModal.matchType')}>
                  <select
                    className={inputCls}
                    value={conditions[0].match_type}
                    onChange={(e) =>
                      updateBlock(0, {
                        match_type: e.target.value as ConditionItem['match_type'],
                        match_value: '',
                      })
                    }
                  >
                    <option value="exact">{t('ruleModal.matchTypeExactShort')}</option>
                    <option value="list">{t('ruleModal.matchTypeListShort')}</option>
                    <option value="regex">{t('ruleModal.matchTypeRegexShort')}</option>
                  </select>
                </Field>
                <Field label={t('ruleModal.value')}>
                  <input
                    className={inputCls}
                    value={conditions[0].match_value}
                    onChange={(e) => updateBlock(0, { match_value: e.target.value })}
                  />
                </Field>
              </div>
              <p className="mt-2 text-[11px] text-zinc-500">
                {t('ruleModal.legacyHint')}
              </p>
            </div>
          ) : form.app_scope === null && form.app_type_scope === null ? (
            <div className="rounded-md border border-dashed border-zinc-700 p-4 text-center text-sm text-zinc-500">
              {t('ruleModal.selectServiceFirst')}
            </div>
          ) : (
            <div className="space-y-2">
              {conditions.map((c, i) => (
                <div key={i}>
                  {i > 0 && (
                    <div className="flex justify-center py-1">
                      <button
                        type="button"
                        onClick={() => toggleJoin(i)}
                        className="rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-semibold text-indigo-300 hover:bg-zinc-700"
                      >
                        {c.join === 'AND' ? t('conditions.joinAnd') : t('conditions.joinOr')}
                      </button>
                    </div>
                  )}
                  <div className="rounded-md border border-zinc-800 bg-zinc-950/30 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-sm font-medium text-zinc-200">
                        {t('ruleModal.conditionNumber', { number: i + 1 })}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeCondition(i)}
                        disabled={conditions.length <= 1}
                        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-red-400 hover:bg-red-950/40 disabled:opacity-30"
                      >
                        <Trash2 className="size-3.5" />
                        {t('ruleModal.removeCondition')}
                      </button>
                    </div>
                    <div className="space-y-3">
                      <div className="grid grid-cols-2 gap-3">
                        <Field label={t('ruleModal.category')}>
                          <select
                            className={inputCls}
                            value={c.category}
                            onChange={(e) => {
                              const cat = e.target.value as ConditionCategory
                              updateBlock(i, {
                                category: cat,
                                // Users has no literal tag suggestions — regex
                                // (the "## - username" style pick) is the only
                                // mode that actually extracts a username, so
                                // switching to it defaults there. Still
                                // overridable via the Match Type dropdown.
                                match_type: cat === 'user' ? 'regex' : c.match_type,
                                match_value: '',
                              })
                            }}
                          >
                            {CATEGORY_ORDER.map((cat) => (
                              <option
                                key={cat}
                                value={cat}
                                disabled={usedCategories.has(cat) && cat !== c.category}
                              >
                                {categoryLabel(cat)}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label={t('ruleModal.matchType')}>
                          <select
                            className={inputCls}
                            value={c.match_type}
                            onChange={(e) =>
                              updateBlock(i, {
                                match_type: e.target.value as ConditionItem['match_type'],
                                match_value: '',
                              })
                            }
                          >
                            <option value="list">{t('ruleModal.matchTypeListOption')}</option>
                            <option value="exact">{t('ruleModal.matchTypeExactOption')}</option>
                            <option value="regex">{t('ruleModal.matchTypeRegex')}</option>
                          </select>
                        </Field>
                      </div>
                      <Field label={t('ruleModal.value')}>{renderConditionValue(i)}</Field>
                    </div>
                  </div>
                </div>
              ))}

              {conditions.length === 0 ? (
                <button
                  type="button"
                  onClick={() => addCondition(null)}
                  className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
                >
                  {t('ruleModal.addConditionFirst')}
                </button>
              ) : (
                !allCategoriesUsed && (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-xs text-zinc-500">{t('ruleModal.addAnotherCondition')}</span>
                    <button
                      type="button"
                      onClick={() => addCondition('AND')}
                      className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                    >
                      {t('ruleModal.addAnd')}
                    </button>
                    <button
                      type="button"
                      onClick={() => addCondition('OR')}
                      className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
                    >
                      {t('ruleModal.addOr')}
                    </button>
                  </div>
                )
              )}
            </div>
          )}
        </div>

        <div className="space-y-3 border-t border-zinc-800 pt-4">
          <div>
            <h3 className="text-sm font-semibold text-zinc-200">{t('ruleModal.settings')}</h3>
            <p className="text-xs text-zinc-500">
              {t('ruleModal.settingsHint')}
            </p>
          </div>

          <Field label={t('ruleModal.dirTemplate')}>
            <input
              className={inputCls}
              required
              value={form.dir_template}
              onChange={(e) => setForm({ ...form, dir_template: e.target.value })}
              placeholder={t('ruleModal.dirTemplatePlaceholder')}
            />
          </Field>
          <Field label={t('ruleModal.filenameTemplate')}>
            <input
              className={inputCls}
              value={form.filename_template ?? ''}
              onChange={(e) =>
                setForm({ ...form, filename_template: e.target.value || null })
              }
              placeholder={t('ruleModal.filenameTemplatePlaceholder')}
            />
          </Field>
          <Field label={t('ruleModal.enabled')}>
            <Toggle
              checked={form.enabled}
              onChange={(v) => setForm({ ...form, enabled: v })}
            />
          </Field>
          <Field label={t('ruleModal.unlinkOnMismatch')}>
            <Toggle
              checked={form.unlink_on_mismatch}
              onChange={(v) => setForm({ ...form, unlink_on_mismatch: v })}
            />
          </Field>
          <Field label={t('ruleModal.priority')}>
            <input
              className={inputCls}
              type="number"
              min={1}
              max={1000}
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
            />
          </Field>
        </div>

        {previewOpen && (
          <div className="rounded-md border border-zinc-800/70 bg-zinc-950/40 p-3">
            <h4 className="mb-2 text-xs font-semibold text-zinc-400">{t('ruleModal.livePreview')}</h4>
            <PreviewPanel rule={previewRule} appId={previewAppId} />
          </div>
        )}

        {err && (
          <div className="rounded-md border border-red-900 bg-red-950/40 p-2 text-sm text-red-300">
            {err}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPreviewOpen((o) => !o)}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
          >
            {previewOpen ? t('ruleModal.hidePreview') : t('ruleModal.livePreviewButton')}
          </button>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-400 hover:bg-zinc-800"
            >
              {t('ruleModal.cancel')}
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {busy ? t('ruleModal.saving') : editing ? t('ruleModal.saveRule') : t('ruleModal.createRule')}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  )
}
