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
  {
    label: 'Number − username (dash)',
    pattern: '^\\d+\\s*-\\s*(?P<user>.+)$',
    hint: 'any number, e.g. 2-alice or 17 - alice → user “alice”',
  },
  {
    label: 'Number username (space)',
    pattern: '^\\d+\\s+(?P<user>.+)$',
    hint: 'any number, e.g. 2 alice → user “alice”',
  },
  {
    label: 'Number:username (colon)',
    pattern: '^\\d+:\\s*(?P<user>.+)$',
    hint: 'any number, e.g. 2:alice → user “alice”',
  },
]

// Genre/certification/language/quality/collection suggestions are backed by
// the DB-persisted `vocabulary` table (genre/certification from TMDB,
// quality from TRaSH Guides + each app's own configured profiles, language
// from each app's own configuration, collection from items already
// imported) — fetched via api.getVocabulary() and refreshed automatically
// in the background (see Settings > Vocabulary). See RuleModal.tsx's
// optionsFor().

/** Extra suggestions surfaced in the Custom tags condition alongside imported app tags. */
export const CUSTOM_TAG_SUGGESTIONS: string[] = ['kids', 'children', 'family']

/** Parse a condition's list match_value into individual tags. */
export function parseList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Join tags back into a condition's list match_value. */
export function joinList(tags: string[]): string {
  return [...new Set(tags)].join(',')
}
