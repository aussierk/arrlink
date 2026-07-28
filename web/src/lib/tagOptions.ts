/**
 * Common tag formats for the ergonomic rule editor.
 *
 * The underlying exact / list / regex match types are unchanged; these are just
 * the building blocks the RuleModal offers as per-category dropdowns so users
 * don't have to write raw regex or comma lists. A condition's match_value is
 * still the single source of truth — the UI parses/renders it against these.
 */

/** Service types ArrLink knows about — extend here (e.g. 'lidarr') as new
 * app integrations are added; no other redesign needed. */
export type ServiceType = 'radarr' | 'sonarr'

/** A named common regex pattern (user-tag conventions only). */
export type RegexPick = {
  label: string
  pattern: string
  hint?: string
}

/** Common regex patterns shown as a dropdown for the Users condition (regex match type). */
export const REGEX_PICKS: RegexPick[] = [
  { label: 'Number − username (dash)', pattern: '^\\d+\\s*-\\s*(?P<user>.+)$', hint: 'any number, e.g. 2-alice or 17 - alice → user “alice”' },
  { label: 'Number username (space)', pattern: '^\\d+\\s+(?P<user>.+)$', hint: 'any number, e.g. 2 alice → user “alice”' },
  { label: 'Number:username (colon)', pattern: '^\\d+:\\s*(?P<user>.+)$', hint: 'any number, e.g. 2:alice → user “alice”' },
]

/** Suggested values for the Genres condition, per service type (movie vs TV
 * genres differ conceptually even where the word lists currently overlap). */
export const GENRE_TAGS_BY_TYPE: Record<ServiceType, string[]> = {
  radarr: [
    'action', 'adventure', 'animation', 'comedy', 'crime', 'drama', 'documentary',
    'horror', 'mystery', 'romance', 'sci-fi', 'thriller', 'western',
  ],
  sonarr: [
    'action', 'adventure', 'animation', 'comedy', 'crime', 'drama', 'documentary',
    'horror', 'mystery', 'romance', 'sci-fi', 'thriller', 'western',
  ],
}

/** Suggested values for the Certification condition, per service type — these
 * genuinely differ (movie ratings vs TV ratings). */
export const CERTIFICATION_TAGS_BY_TYPE: Record<ServiceType, string[]> = {
  radarr: ['G', 'PG', 'PG-13', 'R', 'NC-17'],
  sonarr: ['TV-Y', 'TV-Y7', 'TV-G', 'TV-PG', 'TV-14', 'TV-MA'],
}

export function genreTagsFor(type: ServiceType): string[] {
  return GENRE_TAGS_BY_TYPE[type] ?? []
}

export function certificationTagsFor(type: ServiceType): string[] {
  return CERTIFICATION_TAGS_BY_TYPE[type] ?? []
}

/** Suggested values for the Languages condition — shared across service types. */
export const LANGUAGE_TAGS: string[] = [
  'english', 'spanish', 'french', 'german', 'japanese', 'korean', 'italian',
  'chinese', 'hindi', 'portuguese', 'dutch', 'russian',
]

/** Suggested values for the Quality Profile condition — shared across service types. */
export const QUALITY_PROFILE_TAGS: string[] = [
  '4k', 'uhd', '2160p', 'hdr', 'dolby', '1080p', 'fhd', '720p',
]

/** Suggested values for the Collections condition — no fixed catalog, purely user-entered. */
export const COLLECTION_TAGS: string[] = []

/** Extra suggestions surfaced in the Custom tags condition alongside imported app tags. */
export const CUSTOM_TAG_SUGGESTIONS: string[] = ['kids', 'children', 'family']

/** Parse a condition's list match_value into individual tags. */
export function parseList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Join tags back into a condition's list match_value. */
export function joinList(tags: string[]): string {
  return [...new Set(tags)].join(',')
}

/** Is this match_value one of the known regex picks? (returns the pattern or '') */
export function matchRegexPick(value: string): string {
  return REGEX_PICKS.find((p) => p.pattern === value)?.pattern ?? ''
}
