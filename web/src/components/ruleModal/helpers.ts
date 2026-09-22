import i18n from '../../i18n'
import {
  NUMERIC_CATEGORIES,
  RICH_CATEGORIES,
  type ConditionCategory,
  type ConditionItem,
  type ConditionSource,
  type RuleInput,
  type TagItem,
  type VocabularyEntry,
} from '../../lib/api'
import { CATEGORY_ORDER, NATIVE_ONLY_CATEGORIES } from '../../lib/categoryMeta'
import { CUSTOM_TAG_SUGGESTIONS, joinList, parseList } from '../../lib/tagOptions'

export { CATEGORY_ORDER, categoriesForServiceType } from '../../lib/categoryMeta'

export const RICH = new Set<string>(RICH_CATEGORIES)

// Numeric categories (rating/popularity/runtime): match_type is always
// 'range', source is always 'native' (no tag equivalent) -- the rule editor
// hides the Match Type/Source controls and TagSelect for these, showing a
// min/max pair instead. See NUMERIC_CATEGORIES in lib/api.ts.
export const NUMERIC = new Set<string>(NUMERIC_CATEGORIES)

export const CUSTOM = '__custom__'

// Single canonical label set, shared by the rule modal, the Rules list
// (filter dropdown + condition summary column), and the Tags page
// classifier -- previously three of these existed independently and had
// drifted (e.g. "Genre" vs "Genres", "Custom" vs "Custom tags").
const CATEGORY_LABEL_KEY: Record<string, string> = Object.fromEntries(
  CATEGORY_ORDER.map((cat) => [cat, `category.label.${cat}`]),
)

export function categoryLabel(cat: string): string {
  const key = CATEGORY_LABEL_KEY[cat]
  return key ? i18n.t(key) : cat
}

export type FormState = Omit<RuleInput, 'conditions'>

// Fallback root when the deployment's allowed_roots haven't loaded yet (or
// are empty) -- matches the backend's own DEFAULT_BASE in core/presets.py.
export const DEFAULT_BASE_ROOT = '/media'

export function dirTemplateFor(base: string, serviceType: string | null): string {
  return `${base}${serviceType === 'sonarr' ? '/tv' : '/movies'}`
}

export const emptyForm: FormState = {
  name: '',
  app_scope: null,
  app_type_scope: null,
  dir_template: dirTemplateFor(DEFAULT_BASE_ROOT, 'radarr'),
  filename_template: null,
  dir_naming_mode: 'source',
  enabled: true,
  unlink_on_mismatch: true,
  priority: 100,
}

// dir_template values that count as "the user hasn't touched it yet", so
// picking a service can swap movies<->tv without clobbering real input.
export function pristineDirs(base: string): string[] {
  return [dirTemplateFor(base, 'radarr'), dirTemplateFor(base, 'sonarr')]
}

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

/** A 'range' condition's match_value as {min, max}, tolerating malformed/empty
 * JSON (an in-progress edit) by falling back to both bounds unset. */
export function parseRangeMatchValue(matchValue: string): {
  min: number | null
  max: number | null
} {
  try {
    const d: unknown = JSON.parse(matchValue)
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      const r = d as { min?: unknown; max?: unknown }
      const min = typeof r.min === 'number' ? r.min : null
      const max = typeof r.max === 'number' ? r.max : null
      return { min, max }
    }
  } catch {
    // malformed/empty -- still being edited
  }
  return { min: null, max: null }
}

export function rangeMatchValue(min: number | null, max: number | null): string {
  return JSON.stringify({ min, max })
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

/** The condition patch for a category change in the rule editor: numeric
 * categories force a native range comparison, user/native-only categories
 * default to regex, and genre/native-only categories default to native
 * source -- see the inline comments on each branch for the reasoning. */
export function categoryChangePatch(
  cat: ConditionCategory,
  current: ConditionItem,
): Partial<ConditionItem> {
  // Numeric categories (rating/popularity/runtime) only ever make sense as a
  // native range comparison -- no tag equivalent, no exact/list/regex/vocabulary mode.
  if (NUMERIC.has(cat)) {
    return {
      category: cat,
      match_type: 'range',
      match_value: rangeMatchValue(null, null),
      source: 'native',
    }
  }
  return {
    category: cat,
    // Users has no literal tag suggestions -- regex (the "## - username" style
    // pick) is the only mode that actually extracts a username, so switching to
    // it defaults there (still overridable via Match Type). Title behaves the
    // same way, always against real metadata (see the forced source below) --
    // its own curated regex picks bucket a library alphabetically. Coming
    // *from* a numeric category, match_type was 'range' -- not a valid option
    // here, so it falls back to 'list'.
    match_type:
      cat === 'user' || NATIVE_ONLY_CATEGORIES.has(cat)
        ? 'regex'
        : (current.match_type as string) === 'range'
          ? 'list'
          : current.match_type,
    match_value: '',
    // Genre/Title default to Native: the arr instance's own fields are what
    // most rules actually want (Title has no tag equivalent at all -- see
    // NATIVE_ONLY_CATEGORIES) -- still overridable via the source toggle below
    // for genre. Non-rich categories (user/custom) never allow "native"
    // server-side, so leaving one clears it rather than tripping that
    // validation on save.
    source:
      cat === 'genre' || NATIVE_ONLY_CATEGORIES.has(cat)
        ? 'native'
        : RICH.has(cat)
          ? current.source
          : null,
  }
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

// "vocabulary" means "match anything currently known" -- no free text to
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

// Vocabulary sources that reflect the app instance's own real metadata
// (quality profiles / languages fetched from it, values observed on its
// actual items) as opposed to a shared reference catalog (tmdb/trash) that's
// merely a naming suggestion.
const NATIVE_VOCAB_SOURCES = new Set<VocabularyEntry['source']>(['instance', 'observed'])

/** Suggested values for a condition's category, aware of match source:
 * 'native' (matches the item's real Radarr/Sonarr metadata, see
 * matching.py's match_conditions) surfaces only vocabulary actually pulled
 * from an instance or observed on its items; 'tag' (the default) surfaces
 * the shared reference catalog (tmdb/trash) as naming suggestions plus
 * manually classified tags, since tag matching never looks at native fields.
 * Falls back to the custom-tags set for 'custom', or nothing for 'user'. */
export function optionsForCategory(
  category: ConditionCategory,
  vocab: Vocab,
  tags: TagItem[],
  customOptions: string[],
  source?: ConditionSource | null,
): string[] {
  if (RICH.has(category)) {
    const entries = vocab[category] ?? []
    if (source === 'native') {
      return Array.from(
        new Set(
          entries.filter((v) => NATIVE_VOCAB_SOURCES.has(v.source)).map((v) => v.value),
        ),
      )
    }
    const fromVocab = entries
      .filter((v) => !NATIVE_VOCAB_SOURCES.has(v.source))
      .map((v) => v.value)
    const fromClassifiedTags = tags
      .filter((t) => t.category === category)
      .map((t) => t.label)
    return Array.from(new Set([...fromVocab, ...fromClassifiedTags]))
  }
  if (category === 'custom') return customOptions
  // 'user' has no native field or shared vocab source, but tags classified
  // as 'user' on the Tags page (e.g. "2 - alice") are still a real, curated
  // suggestion source -- an alternative to the regex-extraction flow.
  if (category === 'user') {
    return tags.filter((t) => t.category === 'user').map((t) => t.label)
  }
  return []
}
