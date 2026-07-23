/**
 * Common tag formats for the ergonomic rule editor.
 *
 * The underlying exact / list / regex match types are unchanged; these are just
 * the building blocks the RuleModal offers as dropdowns and multi-selects so
 * users don't have to write raw regex or comma lists. A rule's match_value is
 * still the single source of truth — the UI parses/renders it against these.
 */

/** A named common regex pattern (user-tag conventions, certifications). */
export type RegexPick = {
  label: string
  pattern: string
  hint?: string
}

/** Common regex patterns shown as a dropdown in the rule editor. */
export const REGEX_PICKS: RegexPick[] = [
  { label: 'User tag — “## - username”', pattern: '^##\\s*-\\s*(?P<user>.+)$', hint: '## - alice → user “alice”' },
  { label: 'User tag — “# username”', pattern: '^#\\s*(?P<user>.+)$', hint: '# alice → user “alice”' },
  { label: 'User tag — “user:username”', pattern: '^user:\\s*(?P<user>.+)$', hint: 'user:alice → user “alice”' },
  { label: 'Certification (movies)', pattern: '^(G|PG|PG-13|R|NC-17)$', hint: 'MPAA ratings' },
  { label: 'Certification (TV)', pattern: '^(TV-Y|TV-Y7|TV-G|TV-PG|TV-14|TV-MA)$', hint: 'TV ratings' },
]

/** Suggested tag values for the list multi-select, grouped by convention. */
export type ListGroup = {
  group: string
  tags: string[]
}

export const LIST_GROUPS: ListGroup[] = [
  { group: 'Quality', tags: ['4k', 'uhd', '2160p', 'hdr', 'dolby', '1080p', 'fhd', '720p'] },
  { group: 'Kids / family', tags: ['kids', 'children', 'family', 'G', 'PG'] },
  { group: 'Genre', tags: ['action', 'adventure', 'animation', 'comedy', 'crime', 'drama', 'documentary', 'horror', 'mystery', 'romance', 'sci-fi', 'thriller', 'western'] },
  { group: 'Language', tags: ['english', 'spanish', 'french', 'german', 'japanese', 'korean', 'italian', 'chinese', 'hindi', 'portuguese', 'dutch', 'russian'] },
]

/** Parse a rule's list match_value into individual tags. */
export function parseList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Join tags back into a rule's list match_value. */
export function joinList(tags: string[]): string {
  return [...new Set(tags)].join(',')
}

/** Is this match_value one of the known regex picks? (returns the pattern or '') */
export function matchRegexPick(value: string): string {
  return REGEX_PICKS.find((p) => p.pattern === value)?.pattern ?? ''
}
