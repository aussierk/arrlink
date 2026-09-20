/** Rule matching: does a rule's matcher match an item's tags? The matched tag
 * (and, for regex rules, the match object) drives template placeholder
 * resolution. Ported from core/matching.py. */

export interface RuleMatch {
  tag: string
  regexMatch: RegExpMatchArray | null
}

export type MatchType = 'exact' | 'list' | 'regex'
export type ConditionJoin = 'AND' | 'OR' | null

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

/** Every item tag that satisfies the matcher -- fans one condition into multiple links. */
export function matchRuleAll(
  matchType: string,
  matchValue: string,
  itemTags: string[],
): RuleMatch[] {
  if (matchType === 'exact') {
    const target = matchValue.trim()
    return itemTags.filter((t) => t === target).map((t) => ({ tag: t, regexMatch: null }))
  }

  if (matchType === 'list') {
    const targets = parseListValue(matchValue)
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

  return []
}

/** The first item tag that satisfies the matcher, else null. */
export function matchRule(
  matchType: string,
  matchValue: string,
  itemTags: string[],
): RuleMatch | null {
  const matches = matchRuleAll(matchType, matchValue, itemTags)
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

    const values = cond.source === 'native' ? (native[cond.category] ?? []) : itemTags
    const hits = matchRuleAll(cond.matchType, cond.matchValue, values)
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
