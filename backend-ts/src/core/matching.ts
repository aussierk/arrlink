/** Rule matching: does a rule's matcher match an item's tags? The matched tag
 * (and, for regex rules, the match object) drives template placeholder
 * resolution. Ported from core/matching.py. */

export interface RuleMatch {
  tag: string
  regexMatch: RegExpMatchArray | null
}

// 'vocabulary' is a stored-but-not-directly-matched type: expandVocabularyConditions
// rewrites it to 'list' before match_rule_all ever sees it. 'range' is for
// numeric native fields (rating, popularity, runtime) -- matchValue is
// {"min": number|null, "max": number|null} JSON, either bound omittable for
// an open-ended threshold ("rating >= 7" is {min:7,max:null}).
export type MatchType = 'exact' | 'list' | 'regex' | 'vocabulary' | 'range'
export type ConditionJoin = 'AND' | 'OR' | null

export interface RangeValue {
  min: number | null
  max: number | null
}

/** Parses a 'range' condition's matchValue; null if malformed (never matches,
 * same as an invalid regex). */
export function parseRangeValue(matchValue: string): RangeValue | null {
  try {
    const decoded: unknown = JSON.parse(matchValue)
    if (
      decoded !== null &&
      typeof decoded === 'object' &&
      !Array.isArray(decoded) &&
      ('min' in decoded || 'max' in decoded)
    ) {
      const d = decoded as { min?: unknown; max?: unknown }
      const min = d.min === null || d.min === undefined ? null : Number(d.min)
      const max = d.max === null || d.max === undefined ? null : Number(d.max)
      if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max))) {
        return null
      }
      if (min === null && max === null) return null // no bound at all -- never matches
      return { min, max }
    }
  } catch {
    // malformed JSON
  }
  return null
}

export interface Condition {
  category: string
  matchType: MatchType
  matchValue: string
  join: ConditionJoin
  source?: 'native' | 'tag' | null
}

// Python named groups `(?P<name>...)` / backreferences `(?P=name)` use JS
// syntax instead: `(?<name>...)` / `\k<name>`. Translate before compiling so
// existing user-authored rules keep working. Not covered: lookbehind version
// differences, some Unicode property escapes.
function translatePythonRegexSyntax(pattern: string): string {
  return pattern
    .replace(/\(\?P<([A-Za-z_][A-Za-z0-9_]*)>/g, '(?<$1>')
    .replace(/\(\?P=([A-Za-z_][A-Za-z0-9_]*)\)/g, '\\k<$1>')
}

// Compile (and cache) a rule's regex; null for an invalid pattern (never
// matches). Size-bounded LRU, mirrors Python's lru_cache(maxsize=512).
const REGEX_CACHE_MAX = 512
const regexCache = new Map<string, RegExp | null>()

function compiled(pattern: string): RegExp | null {
  const hit = regexCache.get(pattern)
  if (hit !== undefined) {
    regexCache.delete(pattern)
    regexCache.set(pattern, hit)
    return hit
  }
  let re: RegExp | null
  try {
    re = new RegExp(translatePythonRegexSyntax(pattern))
  } catch {
    re = null
  }
  regexCache.set(pattern, re)
  if (regexCache.size > REGEX_CACHE_MAX) {
    const oldest = regexCache.keys().next().value
    if (oldest !== undefined) regexCache.delete(oldest)
  }
  return re
}

/** Test helper: clears the compiled-regex cache. */
export function clearRegexCache(): void {
  regexCache.clear()
}

function parseListValue(matchValue: string): Set<string> {
  try {
    const decoded: unknown = JSON.parse(matchValue)
    if (Array.isArray(decoded)) {
      return new Set(decoded.map((v) => String(v).trim()).filter((v) => v.length > 0))
    }
  } catch {
    // not JSON -- fall through to comma-split
  }
  return new Set(
    matchValue
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
}

/** Every item tag that satisfies the matcher -- fans one condition into multiple links.
 *
 * `caseInsensitive` is for native-metadata conditions: Radarr/Sonarr's own
 * fields (originalLanguage.name, genres, certifications, quality profile
 * names) use a fixed, known Title Case convention, so comparing
 * case-insensitively there is safe and avoids a silent, unexplained
 * zero-match if a user types "english" instead of "English". Tag matching
 * stays case-sensitive since tags are free-form user data where case can be
 * meaningful. */
export function matchRuleAll(
  matchType: string,
  matchValue: string,
  itemTags: string[],
  caseInsensitive = false,
): RuleMatch[] {
  if (matchType === 'exact') {
    const target = matchValue.trim()
    if (caseInsensitive) {
      const lower = target.toLowerCase()
      return itemTags
        .filter((t) => t.toLowerCase() === lower)
        .map((t) => ({ tag: t, regexMatch: null }))
    }
    return itemTags.filter((t) => t === target).map((t) => ({ tag: t, regexMatch: null }))
  }

  if (matchType === 'list') {
    const targets = parseListValue(matchValue)
    if (caseInsensitive) {
      const lowerTargets = new Set([...targets].map((t) => t.toLowerCase()))
      return itemTags
        .filter((t) => lowerTargets.has(t.toLowerCase()))
        .map((t) => ({ tag: t, regexMatch: null }))
    }
    return itemTags
      .filter((t) => targets.has(t))
      .map((t) => ({ tag: t, regexMatch: null }))
  }

  if (matchType === 'regex') {
    const pattern = compiled(matchValue)
    if (pattern === null) return []
    const out: RuleMatch[] = []
    for (const t of itemTags) {
      const m = t.match(pattern)
      if (m) out.push({ tag: t, regexMatch: m })
    }
    return out
  }

  if (matchType === 'range') {
    const range = parseRangeValue(matchValue)
    if (range === null) return []
    const inRange = (n: number): boolean =>
      (range.min === null || n >= range.min) && (range.max === null || n <= range.max)
    return itemTags
      .filter((t) => {
        const n = Number(t)
        return Number.isFinite(n) && inRange(n)
      })
      .map((t) => ({ tag: t, regexMatch: null }))
  }

  return []
}

/** The first item tag that satisfies the matcher, else null. */
export function matchRule(
  matchType: string,
  matchValue: string,
  itemTags: string[],
  caseInsensitive = false,
): RuleMatch | null {
  const matches = matchRuleAll(matchType, matchValue, itemTags, caseInsensitive)
  return matches.length > 0 ? matches[0] : null
}

/** One condition (identified by its category) that was evaluated and matched
 * while folding a rule's condition chain. */
export interface ConditionMatch {
  category: string
  tag: string
  regexMatch: RegExpMatchArray | null
}

export interface ConditionsResult {
  result: boolean
  matchedConditions: ConditionMatch[]
  allMatches: Record<string, ConditionMatch[]>
}

/** Left-to-right, short-circuiting AND/OR fold over an ordered condition chain. */
export function matchConditions(
  conditions: Condition[],
  itemTags: string[],
  native: Record<string, string[]> = {},
): ConditionsResult {
  if (conditions.length === 0) {
    return { result: false, matchedConditions: [], allMatches: {} }
  }

  let running = false
  const matched: ConditionMatch[] = []
  const allMatches: Record<string, ConditionMatch[]> = {}

  conditions.forEach((cond, i) => {
    if (i > 0) {
      if (cond.join === 'AND' && running === false) return
      if (cond.join === 'OR' && running === true) return
    }

    const isNative = cond.source === 'native'
    const values = isNative ? (native[cond.category] ?? []) : itemTags
    const hits = matchRuleAll(cond.matchType, cond.matchValue, values, isNative)
    const hit = hits.length > 0

    if (i === 0) {
      running = hit
    } else if (cond.join === 'AND') {
      running = running && hit
    } else {
      running = running || hit
    }

    if (hit) {
      const cms = hits.map((m) => ({
        category: cond.category,
        tag: m.tag,
        regexMatch: m.regexMatch,
      }))
      matched.push(cms[0])
      allMatches[cond.category] = cms
    }
  })

  return { result: running, matchedConditions: matched, allMatches }
}
