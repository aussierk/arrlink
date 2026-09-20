import i18n from '../../i18n'
import {
  RICH_CATEGORIES,
  type ConditionCategory,
  type ConditionItem,
  type RuleInput,
  type TagItem,
  type VocabularyEntry,
} from '../../lib/api'
import { CUSTOM_TAG_SUGGESTIONS, joinList, parseList } from '../../lib/tagOptions'

export const RICH = new Set<string>(RICH_CATEGORIES)

export const CUSTOM = '__custom__'

export const CATEGORY_ORDER: ConditionCategory[] = [
  'user',
  'genre',
  'language',
  'quality',
  'certification',
  'collection',
  'custom',
]

const CATEGORY_LABEL_KEY: Record<string, string> = {
  user: 'ruleModal.categoryLabel.user',
  genre: 'ruleModal.categoryLabel.genre',
  language: 'ruleModal.categoryLabel.language',
  quality: 'ruleModal.categoryLabel.quality',
  certification: 'ruleModal.categoryLabel.certification',
  collection: 'ruleModal.categoryLabel.collection',
  custom: 'ruleModal.categoryLabel.custom',
}

export function categoryLabel(cat: string): string {
  const key = CATEGORY_LABEL_KEY[cat]
  return key ? i18n.t(key) : cat
}

export type FormState = Omit<RuleInput, 'conditions'>

export const emptyForm: FormState = {
  name: '',
  app_scope: null,
  app_type_scope: null,
  dir_template: '/media/movies',
  filename_template: null,
  enabled: true,
  unlink_on_mismatch: true,
  priority: 100,
}

// dir_template values that count as "the user hasn't touched it yet", so
// picking a service can swap movies<->tv without clobbering real input.
export const PRISTINE_DIRS = ['/media/movies', '/media/tv']

type ServiceScope = Pick<FormState, 'app_scope' | 'app_type_scope'>

// The Service <select> encodes three kinds of scope in one string value:
// '' (any service), 'type:radarr' / 'type:sonarr' (all instances of that
// type), or a specific app's id.
export function encodeServiceValue(
  appScope: number | null,
  appTypeScope: string | null,
): string {
  if (appTypeScope) return `type:${appTypeScope}`
  return appScope === null ? '' : String(appScope)
}

export function decodeServiceValue(value: string): ServiceScope {
  if (value === '') return { app_scope: null, app_type_scope: null }
  if (value.startsWith('type:')) {
    return {
      app_scope: null,
      app_type_scope: value.slice('type:'.length) as 'radarr' | 'sonarr',
    }
  }
  return { app_scope: Number(value), app_type_scope: null }
}

export function selectedFor(c: ConditionItem): string[] {
  if (c.match_type === 'list') return parseList(c.match_value)
  return c.match_value ? [c.match_value] : []
}

/** Reorders the condition chain and re-normalizes AND/OR joins: index 0 is
 * always null, any interior null backfills to 'AND'. No-op if `to` is out
 * of range. */
export function reorderConditions(
  conditions: ConditionItem[],
  from: number,
  to: number,
): ConditionItem[] {
  if (to < 0 || to >= conditions.length) return conditions
  const next = [...conditions]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next.map((c, idx) => ({
    ...c,
    join: idx === 0 ? null : (c.join ?? 'AND'),
  }))
}

/** The next match_value after a multi-select changes from `prevSelected` to
 * `next`: adds/removes tags for a 'list' match type, else just the single
 * selected value. */
export function nextMatchValueForSelection(
  matchType: ConditionItem['match_type'],
  matchValue: string,
  prevSelected: string[],
  next: string[],
): string {
  if (matchType !== 'list') return next[0] ?? ''
  const removed = prevSelected.filter((tag) => !next.includes(tag))
  const added = next.filter((tag) => !prevSelected.includes(tag))
  const cur = parseList(matchValue).filter((tag) => !removed.includes(tag))
  added.forEach((tag) => {
    if (!cur.includes(tag)) cur.push(tag)
  })
  return joinList(cur)
}

// "vocabulary" means "match anything currently known" — no free text to
// enter. Every other match type stays creatable: vocabulary suggestions may
// simply not be synced yet, and shouldn't block typing a value.
export function creatableFor(matchType: ConditionItem['match_type']): boolean {
  return matchType !== 'vocabulary'
}

export type Vocab = Partial<Record<ConditionCategory, VocabularyEntry[]>>

/** Imported app tags plus the static starter set, minus anything already a
 * known rich-category vocabulary value. */
export function computeCustomOptions(tags: TagItem[], vocab: Vocab): string[] {
  const knownTags = new Set(
    RICH_CATEGORIES.flatMap((cat) => (vocab[cat] ?? []).map((v) => v.value)),
  )
  const appTags = tags.map((t) => t.label).filter((l) => !knownTags.has(l))
  const extra = CUSTOM_TAG_SUGGESTIONS.filter((t) => !knownTags.has(t))
  return Array.from(new Set([...appTags, ...extra]))
}

/** Suggested values for a condition's category: vocabulary + manually
 * classified tags for a rich category, the custom-tags set for 'custom', or
 * nothing for 'user'. */
export function optionsForCategory(
  category: ConditionCategory,
  vocab: Vocab,
  tags: TagItem[],
  customOptions: string[],
): string[] {
  if (RICH.has(category)) {
    const fromVocab = (vocab[category] ?? []).map((v) => v.value)
    const fromClassifiedTags = tags
      .filter((t) => t.category === category)
      .map((t) => t.label)
    return Array.from(new Set([...fromVocab, ...fromClassifiedTags]))
  }
  if (category === 'custom') return customOptions
  return []
}
