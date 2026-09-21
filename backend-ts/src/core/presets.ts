/** Rule presets: one-click, editable rules for common tagging conventions.
 * Ported from core/presets.py. */

const BASE_BY_TYPE: Record<string, string> = {
  radarr: '/media/movies',
  sonarr: '/media/tv',
}
const DEFAULT_BASE = '/media'

export interface Preset {
  key: string
  name: string
  description: string
  category: string
  // source is null ("tag", the default) or 'native' -- see
  // core/matching.ts's Condition and RICH_CATEGORIES in core/vocabulary.ts
  // for what "native" means and which categories support it.
  matchers: Record<
    string,
    [matchType: string, matchValue: string, source: 'native' | null]
  >
  /** Appended to the base folder; may contain {$...} placeholders. */
  subpath: string
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
    matchers: {
      radarr: ['regex', '^(G|PG|PG-13|R|NC-17)$', null],
      sonarr: ['regex', '^(TV-Y|TV-Y7|TV-G|TV-PG|TV-14|TV-MA)$', null],
    },
    subpath: '/{$certification}',
  },
  {
    key: 'kids',
    name: 'Kids / family',
    description: 'Everything kids-related into a single kids folder.',
    category: 'custom',
    matchers: {
      radarr: ['list', 'kids,children,family,G,PG', null],
      sonarr: ['list', 'kids,family,TV-Y,TV-Y7,TV-G,TV-PG', null],
    },
    subpath: '/kids',
  },
  {
    key: '4k',
    name: '4K / HDR',
    description: 'High-res / HDR content into a 4k folder.',
    category: 'quality',
    matchers: {
      radarr: ['list', '4k,uhd,2160p,hdr,dolby', null],
      sonarr: ['list', '4k,uhd,2160p,hdr,dolby', null],
    },
    subpath: '/4k',
  },
  {
    key: '1080p',
    name: '1080p / FHD',
    description: 'Full-HD content into a 1080p folder.',
    category: 'quality',
    matchers: {
      radarr: ['list', '1080p,fhd,1080,high', null],
      sonarr: ['list', '1080p,fhd,1080,high', null],
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
      "One subfolder per language, from Radarr/Sonarr's own language metadata.",
    category: 'language',
    // Same rationale as "genre" above: native metadata via a catch-all
    // regex instead of an enumerated tag list.
    matchers: {
      radarr: ['regex', '.+', 'native'],
      sonarr: ['regex', '.+', 'native'],
    },
    subpath: '/{$language}',
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

/** Render every preset for one app type, with its matcher and dir template. `base`
 * overrides the app-type default base folder. */
export function listPresetsForType(appType: string, base?: string): RenderedPreset[] {
  const b = base || defaultBaseFolder(appType)
  return PRESETS.map((p) => {
    const [matchType, matchValue, source] = p.matchers[appType]
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
}

/** Render one preset for an app type + base folder (undefined if unknown key). */
export function renderPreset(
  key: string,
  appType: string,
  base?: string,
): RenderedPreset | undefined {
  const p = getPreset(key)
  if (!p) return undefined
  const b = base || defaultBaseFolder(appType)
  const [matchType, matchValue, source] = p.matchers[appType]
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
