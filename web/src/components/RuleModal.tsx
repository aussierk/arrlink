import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import Modal from './Modal'
import PreviewPanel from './PreviewPanel'
import Alert from './ui/Alert'
import Button from './ui/Button'
import Toggle from './ui/Toggle'
import Field from './ui/Field'
import ConditionRow from './ruleModal/ConditionRow'
import { useRuleVocabulary } from './ruleModal/useRuleVocabulary'
import {
  CATEGORY_ORDER,
  decodeServiceValue,
  emptyForm,
  encodeServiceValue,
  nextMatchValueForSelection,
  PRISTINE_DIRS,
  reorderConditions,
  type FormState,
} from './ruleModal/helpers'
import {
  api,
  type AppItem,
  type ConditionItem,
  type PresetItem,
  type RuleInput,
  type RuleItem,
  type TagItem,
} from '../lib/api'
import { type ServiceType } from '../lib/tagOptions'
import { inputCls } from '../lib/ui'

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
  onSaved: (saved: RuleItem) => void
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
    api
      .listApps()
      .then(setApps)
      .catch(() => {})
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

  const { vocabWarnings, optionsFor } = useRuleVocabulary({
    form,
    conditions,
    serviceType,
    representativeAppId,
    tags,
  })

  function updateBlock(i: number, patch: Partial<ConditionItem>) {
    setConditions((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)))
  }

  function toggleJoin(i: number) {
    setConditions((cs) =>
      cs.map((c, idx) =>
        idx === i ? { ...c, join: c.join === 'AND' ? 'OR' : 'AND' } : c,
      ),
    )
  }

  function applyBlockSelection(i: number, prevSelected: string[], next: string[]) {
    const c = conditions[i]
    updateBlock(i, {
      match_value: nextMatchValueForSelection(c.match_type, c.match_value, prevSelected, next),
    })
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
    setConditions([...conditions, block])
  }

  function removeCondition(i: number) {
    if (conditions.length <= 1) return
    const next = conditions
      .filter((_, idx) => idx !== i)
      .map((c, idx) => (idx === 0 ? { ...c, join: null } : c))
    setConditions(next)
  }

  function moveCondition(from: number, to: number) {
    setConditions((cs) => reorderConditions(cs, from, to))
  }

  function applyPreset(p: PresetItem) {
    const idx = conditions.findIndex((c) => c.category === p.category)
    if (idx === -1) {
      const join: 'AND' | 'OR' | null = conditions.length === 0 ? null : 'OR'
      setConditions([
        ...conditions,
        {
          category: p.category,
          match_type: p.match_type,
          match_value: p.match_value,
          join,
        },
      ])
    } else {
      setConditions(
        conditions.map((c, i) =>
          i === idx ? { ...c, match_type: p.match_type, match_value: p.match_value } : c,
        ),
      )
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
    if (conditions.some((c) => c.match_type !== 'vocabulary' && !c.match_value.trim())) {
      setErr(t('ruleModal.conditionValueErr'))
      return
    }
    setBusy(true)
    try {
      const body: RuleInput = {
        ...form,
        filename_template: form.filename_template || null,
        conditions: conditions.map((c, i) => ({
          ...c,
          join: i === 0 ? null : (c.join ?? 'AND'),
        })),
      }
      const saved =
        editing && initial
          ? await api.updateRule(initial.id, body)
          : await api.createRule(body)
      onSaved(saved)
      onClose()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  const usedCategories = new Set(conditions.map((c) => c.category))
  const allCategoriesUsed = CATEGORY_ORDER.every((cat) => usedCategories.has(cat))
  const previewRule: RuleInput = { ...form, conditions }
  const noServiceScoped = form.app_scope === null && form.app_type_scope === null

  return (
    <Modal
      title={
        editing
          ? t('ruleModal.editTitle', { name: initial.name })
          : t('ruleModal.newTitle')
      }
      onClose={onClose}
      size="xl"
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-4">
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
              const scope = decodeServiceValue(e.target.value)
              // On a new rule, keep the pristine dir_template default in step
              // with the service kind (movies vs TV) until the user edits it.
              const nextType =
                (apps.find((a) => a.id === scope.app_scope)?.type ??
                  scope.app_type_scope) ||
                null
              const dir =
                !editing && PRISTINE_DIRS.includes(form.dir_template)
                  ? nextType === 'sonarr'
                    ? '/media/tv'
                    : '/media/movies'
                  : form.dir_template
              setForm({ ...form, ...scope, dir_template: dir })
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

        {!noServiceScoped && (
          <div className="rounded-md border border-ring/30 bg-accent-bg p-3">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-accent">
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
                  className="rounded-md border border-line-strong bg-surface px-2.5 py-1 text-xs text-fg hover:border-ring hover:text-accent"
                >
                  {p.name}
                </button>
              ))}
              {presets.length === 0 && (
                <span className="text-xs text-fg-subtle">{t('ruleModal.noPresets')}</span>
              )}
            </div>
            <p className="mt-2 text-xs text-fg-subtle">{t('ruleModal.presetHint')}</p>
          </div>
        )}

        <div className="space-y-3 border-t border-line pt-4">
          <div>
            <h3 className="text-sm font-semibold text-fg">{t('ruleModal.conditions')}</h3>
            <p className="text-xs text-fg-subtle">
              <Trans
                i18nKey="ruleModal.conditionsHintChain"
                components={[<span className="font-mono text-fg-muted" key="genre" />]}
              />
            </p>
          </div>

          {noServiceScoped ? (
            <div className="rounded-md border border-dashed border-line-strong p-4 text-center text-sm text-fg-subtle">
              {t('ruleModal.selectServiceFirst')}
            </div>
          ) : (
            <div className="space-y-2">
              {conditions.map((c, i) => (
                <ConditionRow
                  key={i}
                  condition={c}
                  index={i}
                  total={conditions.length}
                  usedCategories={usedCategories}
                  optionsFor={optionsFor}
                  onUpdate={(patch) => updateBlock(i, patch)}
                  onToggleJoin={() => toggleJoin(i)}
                  onMoveUp={() => moveCondition(i, i - 1)}
                  onMoveDown={() => moveCondition(i, i + 1)}
                  onRemove={() => removeCondition(i)}
                  onApplySelection={(prev, next) => applyBlockSelection(i, prev, next)}
                />
              ))}

              {conditions.length === 0 ? (
                <button
                  type="button"
                  onClick={() => addCondition(null)}
                  className="rounded-md border border-line-strong px-3 py-1.5 text-sm text-fg-soft hover:bg-fill"
                >
                  {t('ruleModal.addConditionFirst')}
                </button>
              ) : (
                !allCategoriesUsed && (
                  <div className="flex items-center gap-2 pt-1">
                    <span className="text-xs text-fg-subtle">
                      {t('ruleModal.addAnotherCondition')}
                    </span>
                    <button
                      type="button"
                      onClick={() => addCondition('AND')}
                      className="rounded-md border border-line-strong px-2.5 py-1 text-xs text-fg-soft hover:bg-fill"
                    >
                      {t('ruleModal.addAnd')}
                    </button>
                    <button
                      type="button"
                      onClick={() => addCondition('OR')}
                      className="rounded-md border border-line-strong px-2.5 py-1 text-xs text-fg-soft hover:bg-fill"
                    >
                      {t('ruleModal.addOr')}
                    </button>
                  </div>
                )
              )}
            </div>
          )}
        </div>

        <div className="space-y-3 border-t border-line pt-4">
          <div>
            <h3 className="text-sm font-semibold text-fg">{t('ruleModal.settings')}</h3>
            <p className="text-xs text-fg-subtle">{t('ruleModal.settingsHint')}</p>
          </div>

          <Field label={t('ruleModal.dirTemplate')}>
            <input
              className={inputCls}
              required
              value={form.dir_template}
              onChange={(e) => setForm({ ...form, dir_template: e.target.value })}
              placeholder={t(
                serviceType === 'sonarr'
                  ? 'ruleModal.dirTemplatePlaceholderTv'
                  : 'ruleModal.dirTemplatePlaceholderMovies',
              )}
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
          <div className="rounded-md border border-line/70 bg-sunken/40 p-3">
            <h4 className="mb-2 text-xs font-semibold text-fg-muted">
              {t('ruleModal.livePreview')}
            </h4>
            <PreviewPanel rule={previewRule} appId={previewAppId} />
          </div>
        )}

        {vocabWarnings.length > 0 && (
          <div className="space-y-1 rounded-md border border-warning-line bg-warning-bg p-2 text-xs text-warning-fg">
            {vocabWarnings.map((w, idx) => (
              <p key={idx}>{w}</p>
            ))}
          </div>
        )}

        <Alert variant="error">{err}</Alert>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => setPreviewOpen((o) => !o)}
          >
            {previewOpen ? t('ruleModal.hidePreview') : t('ruleModal.livePreviewButton')}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t('ruleModal.cancel')}
            </Button>
            <Button type="submit" loading={busy}>
              {busy
                ? t('ruleModal.saving')
                : editing
                  ? t('ruleModal.saveRule')
                  : t('ruleModal.createRule')}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  )
}
