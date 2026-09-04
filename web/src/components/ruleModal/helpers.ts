import i18n from '../../i18n'
import {
  RICH_CATEGORIES,
  type ConditionCategory,
  type ConditionItem,
  type RuleInput,
} from '../../lib/api'
import { parseList } from '../../lib/tagOptions'

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

// "vocabulary" means "match anything currently known" — no free text to
// enter. Every other match type stays creatable: vocabulary suggestions may
// simply not be synced yet, and shouldn't block typing a value.
export function creatableFor(matchType: ConditionItem['match_type']): boolean {
  return matchType !== 'vocabulary'
}
