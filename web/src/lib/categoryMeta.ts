import { NUMERIC_CATEGORIES, RICH_CATEGORIES, type ConditionCategory } from './api'

/** Single source of truth for how a condition category is presented and
 * where it's valid: display order, which app type(s) it applies to (studio
 * is Radarr-only; network/series_type/popularity are their own app's
 * exclusive fields -- see api.ts's RICH_CATEGORIES/NUMERIC_CATEGORIES
 * comments), and which conceptual group it belongs to for grouped pickers.
 * Everything that used to hand-list the 19 categories (the rule modal's
 * dropdown, the Rules list filter/column, the Tags page classifier) should
 * read from this table instead. */

export type CategoryGroup = 'freeform' | 'metadata' | 'provenance' | 'technical' | 'numeric'

export const CATEGORY_GROUP_ORDER: CategoryGroup[] = [
  'freeform',
  'metadata',
  'provenance',
  'technical',
  'numeric',
]

type CategoryMeta = {
  group: CategoryGroup
  // null = valid for every app type.
  appTypes: Array<'radarr' | 'sonarr'> | null
}

export const CATEGORY_META: Record<ConditionCategory, CategoryMeta> = {
  user: { group: 'freeform', appTypes: null },
  title: { group: 'freeform', appTypes: null },
  custom: { group: 'freeform', appTypes: null },

  genre: { group: 'metadata', appTypes: null },
  language: { group: 'metadata', appTypes: null },
  audio_language: { group: 'metadata', appTypes: null },
  certification: { group: 'metadata', appTypes: null },
  collection: { group: 'metadata', appTypes: null },

  studio: { group: 'provenance', appTypes: ['radarr'] },
  network: { group: 'provenance', appTypes: ['sonarr'] },
  series_type: { group: 'provenance', appTypes: ['sonarr'] },

  quality: { group: 'technical', appTypes: null },
  video_codec: { group: 'technical', appTypes: null },
  video_dynamic_range: { group: 'technical', appTypes: null },
  audio_codec: { group: 'technical', appTypes: null },
  audio_channels: { group: 'technical', appTypes: null },

  rating: { group: 'numeric', appTypes: null },
  // Radarr-only: TMDB's popularity score, no Sonarr equivalent.
  popularity: { group: 'numeric', appTypes: ['radarr'] },
  runtime: { group: 'numeric', appTypes: null },
}

export const CATEGORY_ORDER: ConditionCategory[] = [
  'user',
  'title',
  'custom',
  'genre',
  'language',
  'audio_language',
  'certification',
  'collection',
  'studio',
  'network',
  'series_type',
  'quality',
  'video_codec',
  'video_dynamic_range',
  'audio_codec',
  'audio_channels',
  'rating',
  'popularity',
  'runtime',
]

/** The subset of CATEGORY_ORDER that's actually valid for a given service
 * type -- e.g. hides `studio` for Sonarr rules and `network`/`series_type`/
 * `popularity` for Radarr rules. */
export function categoriesForServiceType(
  serviceType: 'radarr' | 'sonarr',
): ConditionCategory[] {
  return CATEGORY_ORDER.filter((cat) => {
    const appTypes = CATEGORY_META[cat].appTypes
    return appTypes === null || appTypes.includes(serviceType)
  })
}

// Sanity check (dev-time only): every RICH/NUMERIC category from api.ts must
// have metadata here -- keeps the two files honest about which categories
// exist without hand-syncing a second list.
if (import.meta.env?.DEV) {
  const known = new Set(CATEGORY_ORDER)
  for (const cat of [...RICH_CATEGORIES, ...NUMERIC_CATEGORIES]) {
    if (!known.has(cat)) {
      console.error(`categoryMeta.ts is missing category "${cat}" from CATEGORY_ORDER`)
    }
  }
}
