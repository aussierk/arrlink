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
  matchers: Record<string, [matchType: string, matchValue: string]>
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
      radarr: ['regex', '^\\d+\\s*-\\s*(?P<user>.+)$'],
      sonarr: ['regex', '^\\d+\\s*-\\s*(?P<user>.+)$'],
    },
    subpath: '/{$user}',
  },
  {
    key: 'certification',
    name: 'Certification',
    description: 'One subfolder per rating, directly under the base folder.',
    category: 'certification',
    matchers: {
      radarr: ['regex', '^(G|PG|PG-13|R|NC-17)$'],
      sonarr: ['regex', '^(TV-Y|TV-Y7|TV-G|TV-PG|TV-14|TV-MA)$'],
    },
    subpath: '/{$certification}',
  },
  {
    key: 'kids',
    name: 'Kids / family',
    description: 'Everything kids-related into a single kids folder.',
    category: 'custom',
    matchers: {
      radarr: ['list', 'kids,children,family,G,PG'],
      sonarr: ['list', 'kids,family,TV-Y,TV-Y7,TV-G,TV-PG'],
    },
    subpath: '/kids',
  },
  {
    key: '4k',
    name: '4K / HDR',
    description: 'High-res / HDR content into a 4k folder.',
    category: 'quality',
    matchers: {
      radarr: ['list', '4k,uhd,2160p,hdr,dolby'],
      sonarr: ['list', '4k,uhd,2160p,hdr,dolby'],
    },
    subpath: '/4k',
  },
  {
    key: '1080p',
    name: '1080p / FHD',
    description: 'Full-HD content into a 1080p folder.',
    category: 'quality',
    matchers: {
      radarr: ['list', '1080p,fhd,1080,high'],
      sonarr: ['list', '1080p,fhd,1080,high'],
    },
    subpath: '/1080p',
  },
  {
    key: 'genre',
    name: 'Genre',
    description: 'One subfolder per genre. Pick the genres you want.',
    category: 'genre',
    matchers: {
      radarr: [
        'list',
        'action,adventure,animation,comedy,crime,drama,documentary,family,horror,mystery,romance,sci-fi,thriller,western',
      ],
      sonarr: [
        'list',
        'action,adventure,animation,comedy,crime,drama,documentary,family,horror,mystery,romance,sci-fi,thriller,western',
      ],
    },
    subpath: '/{$genre}',
  },
  {
    key: 'language',
    name: 'Language',
    description: 'One subfolder per language. Pick the languages you want.',
    category: 'language',
    matchers: {
      radarr: [
        'list',
        'english,spanish,french,german,japanese,korean,italian,chinese,hindi,portuguese,dutch,russian',
      ],
      sonarr: [
        'list',
        'english,spanish,french,german,japanese,korean,italian,chinese,hindi,portuguese,dutch,russian',
      ],
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
    const [matchType, matchValue] = p.matchers[appType]
    return {
      key: p.key,
      name: p.name,
      description: p.description,
      category: p.category,
      matchType,
      matchValue,
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
  const [matchType, matchValue] = p.matchers[appType]
  return {
    key: p.key,
    name: p.name,
    category: p.category,
    matchType,
    matchValue,
    subpath: p.subpath,
    baseFolder: b,
    dirTemplate: dirTemplate(b, p.subpath),
  }
}
