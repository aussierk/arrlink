import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import type { DbClient } from '../db/client.js'
import { tags as tagsTable, vocabulary } from '../db/schema.js'
import type { SettingsStore } from '../db/settings-store.js'
import type { Condition } from './matching.js'
import type { PlannerRule } from './planner.js'

/** Vocabulary: known values per rule-condition category. Ported from core/vocabulary.py. */

const TMDB_BASE = 'https://api.themoviedb.org/3'
const TMDB_CERTIFICATION_COUNTRY = 'US'
const TRASH_QUALITY_URL =
  'https://raw.githubusercontent.com/TRaSH-Guides/Guides/master/docs/json/radarr/quality-size/movie.json'

export const RICH_CATEGORIES = new Set([
  'genre',
  'certification',
  'collection',
  'quality',
  'language',
  'audio_language',
])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Effective TMDB key: a per-instance Setting overrides the operator-configured env default. */
export function tmdbApiKey(settingsStore: SettingsStore): string {
  const override = (settingsStore.getSetting<string>('tmdb_api_key') ?? '').trim()
  return override || process.env.TMDB_API_KEY || ''
}

async function tmdbGet(path: string, apiKey: string): Promise<unknown> {
  const url = new URL(`${TMDB_BASE}${path}`)
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('language', 'en')
  const r = await fetch(url)
  if (!r.ok) throw new Error(`TMDB HTTP ${r.status}`)
  return r.json()
}

/** Full-replace a (category, app_type, app_id) vocabulary scope. */
export function syncVocabularyRows(
  db: DbClient,
  category: string,
  appType: string,
  appId: number | null,
  entries: Array<[string, string | null]>,
  source: string,
): number {
  const now = Date.now() / 1000
  const scope = appId !== null ? eq(vocabulary.appId, appId) : isNull(vocabulary.appId)
  db.delete(vocabulary)
    .where(and(eq(vocabulary.category, category), eq(vocabulary.appType, appType), scope))
    .run()
  for (const [value, externalId] of entries) {
    db.insert(vocabulary)
      .values({ category, appType, appId, value, externalId, source, importedAt: now })
      .run()
  }
  return entries.length
}

/** Fetch genre + certification lists from TMDB, persisted as shared (app_id null)
 * vocabulary. No-ops when no TMDB key is configured -- best-effort, never throws for that case. */
export async function syncTmdbVocabulary(
  db: DbClient,
  settingsStore: SettingsStore,
): Promise<Record<string, number>> {
  const key = tmdbApiKey(settingsStore)
  if (!key) return {}

  const counts: Record<string, number> = {}

  const genrePaths: Record<string, string> = {
    radarr: '/genre/movie/list',
    sonarr: '/genre/tv/list',
  }
  for (const [appType, path] of Object.entries(genrePaths)) {
    const data = await tmdbGet(path, key)
    const genres = isRecord(data) && Array.isArray(data.genres) ? data.genres : []
    const entries: Array<[string, string]> = genres
      .filter((g): g is Record<string, unknown> => isRecord(g) && Boolean(g.name))
      .map((g) => [String(g.name).trim(), String(g.id)])
    counts[`genre:${appType}`] = syncVocabularyRows(
      db,
      'genre',
      appType,
      null,
      entries,
      'tmdb',
    )
  }

  const certPaths: Record<string, string> = {
    radarr: '/certification/movie/list',
    sonarr: '/certification/tv/list',
  }
  const country =
    settingsStore.getSetting<string>('tmdb_certification_country') ||
    TMDB_CERTIFICATION_COUNTRY
  for (const [appType, path] of Object.entries(certPaths)) {
    const data = await tmdbGet(path, key)
    const byCountry =
      isRecord(data) && isRecord(data.certifications) ? data.certifications : {}
    const rows = Array.isArray(byCountry[country]) ? byCountry[country] : []
    const entries: Array<[string, null]> = (rows as unknown[])
      .filter(
        (c): c is Record<string, unknown> => isRecord(c) && Boolean(c.certification),
      )
      .map((c) => [String(c.certification).trim(), null])
    counts[`certification:${appType}`] = syncVocabularyRows(
      db,
      'certification',
      appType,
      null,
      entries,
      'tmdb',
    )
  }

  return counts
}

/** Fetch TRaSH Guides' quality-profile naming dictionary (public, no key), persisted as
 * shared 'quality' vocabulary. Best-effort -- caller logs and swallows failures. */
export async function syncTrashVocabulary(
  db: DbClient,
  appType: string,
): Promise<number> {
  const r = await fetch(TRASH_QUALITY_URL)
  if (!r.ok) throw new Error(`TRaSH HTTP ${r.status}`)
  const data: unknown = await r.json()
  const names = new Set<string>()
  if (Array.isArray(data)) {
    for (const row of data as unknown[]) {
      if (isRecord(row) && typeof row.name === 'string' && row.name.trim()) {
        names.add(row.name.trim())
      }
    }
  }
  const entries: Array<[string, null]> = [...names].map((n) => [n, null])
  return syncVocabularyRows(db, 'quality', appType, null, entries, 'trash')
}

/** Every known value for a scope: shared (app_id null) vocabulary, plus every one of
 * `appIds`' own instance-scoped vocabulary and any tag manually classified into this
 * category. `appIds` is a single instance for an app-scoped rule, every enabled instance
 * of that type for a type-scoped rule (see api/rules.ts's scopeAppIds), or [] for a real
 * poll/preview against one already-known app (expandVocabularyConditions). */
function vocabularyValues(
  db: DbClient,
  category: string,
  appType: string,
  appIds: number[],
): Set<string> {
  const scope =
    appIds.length > 0
      ? or(isNull(vocabulary.appId), inArray(vocabulary.appId, appIds))
      : isNull(vocabulary.appId)
  const rows = db
    .select({ value: vocabulary.value })
    .from(vocabulary)
    .where(and(eq(vocabulary.category, category), eq(vocabulary.appType, appType), scope))
    .all()
  const values = new Set(rows.map((r) => r.value))
  if (appIds.length > 0) {
    const tagRows = db
      .select({ label: tagsTable.label })
      .from(tagsTable)
      .where(and(inArray(tagsTable.appId, appIds), eq(tagsTable.category, category)))
      .all()
    for (const r of tagRows) values.add(r.label)
  }
  return values
}

/** Replace every match_type=='vocabulary' condition with an equivalent 'list' condition. */
export function expandVocabularyConditions(
  rules: PlannerRule[],
  db: DbClient,
  appId: number | null,
  appType: string | null,
): PlannerRule[] {
  // Unscoped rule (no specific app/app_type): nothing to resolve against --
  // leave any vocabulary condition as a no-op empty list.
  const expandTo = (category: string): Set<string> =>
    appType === null
      ? new Set()
      : vocabularyValues(db, category, appType, appId !== null ? [appId] : [])

  return rules.map((rule) => ({
    ...rule,
    conditions: rule.conditions.map((cond): Condition => {
      if (cond.matchType !== 'vocabulary') return cond
      const values = expandTo(cond.category)
      return {
        ...cond,
        matchType: 'list',
        matchValue: JSON.stringify([...values].sort()),
      }
    }),
  }))
}

/** Soft-warning check: flags exact/list literal values not found in a category's known
 * vocabulary. Regex has no finite value to check, so it's never flagged. */
export function validateConditionValues(
  cond: Condition,
  db: DbClient,
  appType: string | null,
  appIds: number[],
): string[] {
  if (
    !RICH_CATEGORIES.has(cond.category) ||
    (cond.matchType !== 'exact' && cond.matchType !== 'list')
  ) {
    return []
  }
  if (appType === null) return []
  const known = vocabularyValues(db, cond.category, appType, appIds)
  if (known.size === 0) return []

  const candidates =
    cond.matchType === 'exact'
      ? [cond.matchValue.trim()]
      : cond.matchValue
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)

  return candidates
    .filter((v) => v && !known.has(v))
    .map(
      (v) =>
        `'${v}' is not a known ${cond.category} value for this app -- check spelling, ` +
        'or classify the matching tag into this category on the Tags page',
    )
}
