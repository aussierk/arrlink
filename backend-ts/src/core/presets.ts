/** Rule presets: one-click, editable rules for common tagging conventions.
 * Ported from core/presets.py. */

const BASE_BY_TYPE: Record<string, string> = {
  radarr: '/media/movies',
  sonarr: '/media/tv',
}
const DEFAULT_BASE = '/media'

type AppType = 'radarr' | 'sonarr'

export interface Preset {
  key: string
  name: string
  description: string
  category: string
  // source is null ("tag", the default) or 'native' -- see
  // core/matching.ts's Condition and RICH_CATEGORIES in core/vocabulary.ts
  // for what "native" means and which categories support it.
  matchers: Partial<
    Record<AppType, [matchType: string, matchValue: string, source: 'native' | null]>
  >
  /** Appended to the base folder; may contain {$...} placeholders. */
  subpath: string
  /** Restricts which app type(s) this preset applies to -- omit for both.
   * Used for concepts that only exist on one side (studio is Radarr-only,
   * network/series_type/collection are Sonarr- or Radarr-only). */
  appTypes?: AppType[]
}

export const PRESETS: Preset[] = [
  {
    key: 'user',
    name: 'Users',
    description: "One subfolder per user, from '2 - alice' style tags.",
    category: 'user',
    matchers: {
      radarr: ['regex', '^\\d+\\s*-\\s*(?P<user>.+)$', null],
      sonarr: ['regex', '^\\d+\\s*-\\s*(?P<user>.+)$', null],
    },
    subpath: '/{$user}',
  },
  {
    key: 'certification',
    name: 'Certification',
    description: 'One subfolder per rating, directly under the base folder.',
    category: 'certification',
    // Native metadata via a catch-all regex, same rationale as genre/language
    // below -- complete by construction instead of an enumerated tag list
    // that goes stale the moment an unlisted rating shows up.
    matchers: {
      radarr: ['regex', '.+', 'native'],
      sonarr: ['regex', '.+', 'native'],
    },
    subpath: '/{$certification}',
  },
  {
    key: 'kids',
    name: 'Kids / family',
    description: 'Everything kids-related into a single kids folder.',
    category: 'certification',
    // Native certification, not tag guesses -- most libraries don't carry
    // rating-named tags, and this now matches the item's real rating.
    matchers: {
      radarr: ['regex', '^(G|PG)$', 'native'],
      sonarr: ['regex', '^(TV-Y|TV-Y7|TV-G|TV-PG)$', 'native'],
    },
    subpath: '/kids',
  },
  {
    key: '4k',
    name: '4K / HDR',
    description: 'HDR content into a 4k folder, from the file’s real mediaInfo.',
    category: 'video_dynamic_range',
    // Native mediaInfo, not a tag guess -- video_dynamic_range is the file's
    // literal technical truth (see api.ts's RICH_CATEGORIES comment), unlike
    // a quality profile name that may or may not mention "4k"/"HDR".
    matchers: {
      radarr: ['list', 'HDR10,HDR10+,DV,HLG,PQ', 'native'],
      sonarr: ['list', 'HDR10,HDR10+,DV,HLG,PQ', 'native'],
    },
    subpath: '/4k',
  },
  {
    key: '1080p',
    name: '1080p / FHD',
    description: "Full-HD content into a 1080p folder, from the quality profile's name.",
    category: 'quality',
    // Resolution has no dedicated native field (only the configured quality
    // profile's name, which is user-defined but usually mentions the
    // resolution) -- native regex against that instead of guessing tags.
    matchers: {
      radarr: ['regex', '.*1080.*', 'native'],
      sonarr: ['regex', '.*1080.*', 'native'],
    },
    subpath: '/1080p',
  },
  {
    key: 'genre',
    name: 'Genre',
    description: "One subfolder per genre, from Radarr/Sonarr's own genre metadata.",
    category: 'genre',
    // Native metadata, not tags: a hardcoded tag list can't enumerate every
    // genre a library will ever have, and most libraries don't carry
    // genre-named tags at all. A catch-all regex against the item's real
    // genres is complete by construction and fans out via the planner's
    // existing multi-genre variant handling.
    matchers: {
      radarr: ['regex', '.+', 'native'],
      sonarr: ['regex', '.+', 'native'],
    },
    subpath: '/{$genre}',
  },
  {
    key: 'language',
    name: 'Language',
    description:
      "One subfolder per original language, from Radarr/Sonarr's own language metadata.",
    category: 'language',
    // Same rationale as "genre" above: native metadata via a catch-all
    // regex instead of an enumerated tag list.
    matchers: {
      radarr: ['regex', '.+', 'native'],
      sonarr: ['regex', '.+', 'native'],
    },
    subpath: '/{$language}',
  },
  {
    key: 'audio_language',
    name: 'Audio language',
    description: "One subfolder per audio track language, from the file's real mediaInfo.",
    category: 'audio_language',
    matchers: {
      radarr: ['regex', '.+', 'native'],
      sonarr: ['regex', '.+', 'native'],
    },
    subpath: '/{$audio_language}',
  },
  {
    key: 'studio',
    name: 'Studio',
    description: "One subfolder per studio, from Radarr's own metadata.",
    category: 'studio',
    matchers: {
      radarr: ['regex', '.+', 'native'],
    },
    subpath: '/{$studio}',
    appTypes: ['radarr'],
  },
  {
    key: 'network',
    name: 'Network',
    description: "One subfolder per network, from Sonarr's own metadata.",
    category: 'network',
    matchers: {
      sonarr: ['regex', '.+', 'native'],
    },
    subpath: '/{$network}',
    appTypes: ['sonarr'],
  },
  {
    key: 'anime',
    name: 'Anime',
    description: "Anime series into their own folder, from Sonarr's series type.",
    category: 'series_type',
    matchers: {
      sonarr: ['exact', 'anime', 'native'],
    },
    subpath: '/anime',
    appTypes: ['sonarr'],
  },
  {
    key: 'collection',
    name: 'Collection',
    description: "One subfolder per collection/franchise, from Radarr's own metadata.",
    category: 'collection',
    matchers: {
      radarr: ['regex', '.+', 'native'],
    },
    subpath: '/{$collection}',
    // Sonarr series have no collection concept -- always null there.
    appTypes: ['radarr'],
  },
  {
    key: 'title-alpha',
    name: 'Alphabetical',
    description: 'One subfolder per starting letter, from the title.',
    category: 'title',
    matchers: {
      radarr: ['regex', '^[^A-Za-z]*(?P<title>[A-Za-z])', 'native'],
      sonarr: ['regex', '^[^A-Za-z]*(?P<title>[A-Za-z])', 'native'],
    },
    subpath: '/{$title}',
  },
]

export function getPreset(key: string): Preset | undefined {
  return PRESETS.find((p) => p.key === key)
}

export function defaultBaseFolder(appType: string): string {
  return BASE_BY_TYPE[appType] ?? DEFAULT_BASE
}

function dirTemplate(base: string, subpath: string): string {
  return base.replace(/\/+$/, '') + subpath
}

export interface RenderedPreset {
  key: string
  name: string
  description?: string
  category: string
  matchType: string
  matchValue: string
  source: 'native' | null
  subpath: string
  defaultBaseFolder?: string
  baseFolder?: string
  dirTemplate: string
}

/** List presets that actually apply to one app type, each with its matcher
 * and dir template. `base` overrides the app-type default base folder. */
export function listPresetsForType(appType: string, base?: string): RenderedPreset[] {
  const b = base || defaultBaseFolder(appType)
  return PRESETS.filter((p) => !p.appTypes || p.appTypes.includes(appType as AppType))
    .map((p): RenderedPreset | null => {
      const matcher = p.matchers[appType as AppType]
      if (!matcher) return null
      const [matchType, matchValue, source] = matcher
      return {
        key: p.key,
        name: p.name,
        description: p.description,
        category: p.category,
        matchType,
        matchValue,
        source,
        subpath: p.subpath,
        defaultBaseFolder: defaultBaseFolder(appType),
        dirTemplate: dirTemplate(b, p.subpath),
      }
    })
    .filter((p): p is RenderedPreset => p !== null)
}

/** Render one preset for an app type + base folder (undefined if unknown key
 * or if the preset doesn't apply to that app type). */
export function renderPreset(
  key: string,
  appType: string,
  base?: string,
): RenderedPreset | undefined {
  const p = getPreset(key)
  if (!p) return undefined
  if (p.appTypes && !p.appTypes.includes(appType as AppType)) return undefined
  const matcher = p.matchers[appType as AppType]
  if (!matcher) return undefined
  const b = base || defaultBaseFolder(appType)
  const [matchType, matchValue, source] = matcher
  return {
    key: p.key,
    name: p.name,
    category: p.category,
    matchType,
    matchValue,
    source,
    subpath: p.subpath,
    baseFolder: b,
    dirTemplate: dirTemplate(b, p.subpath),
  }
}
