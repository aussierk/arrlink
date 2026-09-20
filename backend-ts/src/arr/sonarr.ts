import { statSync, type Stats } from 'node:fs'
import { basename, relative } from 'node:path'
import { BaseAdapter } from './base.js'
import { scandirStats } from './scandir-stats.js'
import {
  AdapterError,
  asStr,
  translateTagLabels,
  type AppInfo,
  type Item,
  type MediaFile,
  type Tag,
} from './types.js'

// Bound concurrent per-series episodefile requests so a large library does
// not open a flood of connections at once.
const FILE_FETCH_CONCURRENCY = 16

interface SonarrSeriesRow {
  id?: number
  title?: string
  year?: number
  path?: string
  tags?: unknown
  genres?: unknown
  certification?: string
  qualityProfileId?: number | null
  originalLanguage?: { name?: string } | null
  statistics?: { episodeFileCount?: number; sizeOnDisk?: number } | null
}

interface SonarrEpisodeFileRow {
  path?: string
  size?: number
}

interface SeriesMeta {
  title: string
  year: number | null
  path: string
  tags: string[]
  genres: string[]
  certification: string | null
  collection: null
  qualityProfileId: number | null
  qualityProfileName: string | null
  originalLanguage: string | null
  statsFingerprint: string | null
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * A cheap "did this series' file set change" marker from the series
 * payload's own statistics block -- no extra call. Null when the payload
 * carries no statistics (then the poller always re-fetches, never skips).
 */
function seriesFingerprint(s: SonarrSeriesRow): string | null {
  if (!s.statistics || typeof s.statistics !== 'object') return null
  return `${s.statistics.episodeFileCount ?? 0}:${s.statistics.sizeOnDisk ?? 0}`
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

export class SonarrAdapter extends BaseAdapter {
  readonly appType = 'sonarr' as const

  async ping(): Promise<AppInfo> {
    const data = (await this.getJson('/api/v3/system/status')) as { version?: unknown }
    if (!data || typeof data !== 'object' || !('version' in data)) {
      throw new AdapterError('unexpected system/status payload')
    }
    return { name: 'sonarr', version: String(data.version) }
  }

  async fetchTags(): Promise<Tag[]> {
    const data = await this.getJson('/api/v3/tag')
    if (!Array.isArray(data)) throw new AdapterError('unexpected tag payload')
    const tags: Tag[] = []
    for (const row of data) {
      if (!row || typeof row !== 'object') continue
      const r = row as { label?: unknown; count?: unknown; id?: unknown }
      const label = asStr(r.label).trim()
      if (!label) continue
      const count = Number.isFinite(Number(r.count)) ? Number(r.count) : 0
      const id = toNumberOrNull(r.id)
      tags.push({ label, count, id })
    }
    return tags
  }

  async createTag(label: string): Promise<void> {
    const trimmed = (label || '').trim()
    if (!trimmed) throw new AdapterError('tag label is empty')
    const r = await this.postJson('/api/v3/tag', { label: trimmed })
    if (r.status === 401 || r.status === 403)
      throw new AdapterError('bad API key (401)', 401)
    if (r.status !== 200 && r.status !== 201) {
      throw new AdapterError(`HTTP ${r.status} creating tag '${trimmed}'`, r.status)
    }
  }

  async fetchItems(
    knownFingerprints?: Map<number, string>,
    tags?: Tag[],
  ): Promise<Item[]> {
    const known = knownFingerprints ?? new Map<number, string>()

    // Independent preamble calls -- series list, quality-profile names, and
    // (unless the caller supplied it) the tag vocabulary -- run
    // concurrently. Profile names aren't on the series rows, only the id.
    const [seriesData, profileById, vocabulary] = await Promise.all([
      this.getJson('/api/v3/series'),
      this.qualityProfileNames(),
      tags ? Promise.resolve(tags) : this.fetchTags(),
    ])
    if (!Array.isArray(seriesData)) throw new AdapterError('unexpected series payload')

    const meta = new Map<number, SeriesMeta>()
    for (const s of seriesData as SonarrSeriesRow[]) {
      if (!s || typeof s !== 'object' || s.id == null) continue
      const sid = Number(s.id)
      const qpId = toNumberOrNull(s.qualityProfileId)
      meta.set(sid, {
        title: String(s.title ?? ''),
        year: toNumberOrNull(s.year),
        path: String(s.path ?? ''),
        tags: translateTagLabels(vocabulary, s.tags),
        genres: (Array.isArray(s.genres) ? s.genres : [])
          .map((g) => String(g).trim())
          .filter(Boolean),
        certification: (s.certification ?? '').trim() || null,
        // Sonarr series have no collection concept -- always null.
        collection: null,
        qualityProfileId: qpId,
        qualityProfileName: qpId !== null ? (profileById.get(qpId) ?? null) : null,
        originalLanguage: s.originalLanguage?.name?.trim() || null,
        statsFingerprint: seriesFingerprint(s),
      })
    }
    if (meta.size === 0) return []

    // Delta fetch: only pull /episodefile for series whose fingerprint
    // changed (or that we have no fingerprint for). Unchanged series are
    // returned with filesStale=true and the poller reuses stored rows.
    const toFetch = [...meta.entries()]
      .filter(
        ([sid, m]) =>
          m.statsFingerprint === null || known.get(sid) !== m.statsFingerprint,
      )
      .map(([sid]) => sid)

    const fetchedEntries = await mapWithConcurrency(
      toFetch,
      FILE_FETCH_CONCURRENCY,
      async (sid): Promise<[number, MediaFile[]]> => {
        const data = await this.getJson(`/api/v3/episodefile?seriesId=${sid}`)
        if (!Array.isArray(data)) {
          throw new AdapterError(`unexpected episodefile payload for series ${sid}`)
        }
        const seriesPath = meta.get(sid)!.path
        const specs = (data as SonarrEpisodeFileRow[])
          .filter((f) => f && typeof f === 'object' && f.path)
          .map((f) => ({ path: String(f.path), size: f.size }))

        // One directory listing per episode directory (season folder)
        // instead of one stat per file.
        const stats = scandirStats(specs.map((s) => s.path))
        const files = specs.map((s) =>
          statFile(s.path, seriesPath, s.size, stats.get(s.path)),
        )
        return [sid, files]
      },
    )
    const fetched = new Map(fetchedEntries)

    const items: Item[] = []
    for (const [sid, m] of meta) {
      const common = {
        id: sid,
        title: m.title,
        year: m.year,
        tags: m.tags,
        path: m.path,
        genres: m.genres,
        certification: m.certification,
        collection: m.collection,
        qualityProfileId: m.qualityProfileId,
        qualityProfileName: m.qualityProfileName,
        originalLanguage: m.originalLanguage,
        statsFingerprint: m.statsFingerprint,
      }
      if (fetched.has(sid)) {
        const itemFiles = fetched.get(sid)!
        if (itemFiles.length === 0) continue // series with no files on disk
        items.push({ ...common, files: itemFiles, filesStale: false })
      } else {
        // unchanged since last poll -> poller rehydrates files from the
        // stored app_files rows before reconciling.
        items.push({ ...common, files: [], filesStale: true })
      }
    }
    return items
  }
}

/** Build a MediaFile, statting the file for its real inode. */
function statFile(
  path: string,
  seriesPath: string,
  apiSize: number | undefined,
  st: Stats | undefined,
): MediaFile {
  let fsize: number | null
  let fmtime: number | null
  let finode: number | null
  try {
    const stat = st ?? statSync(path)
    fsize = stat.size
    fmtime = stat.mtimeMs / 1000
    finode = stat.ino
  } catch {
    fsize = toNumberOrNull(apiSize)
    fmtime = null
    finode = null
  }
  let rel = seriesPath ? relative(seriesPath, path) : basename(path)
  if (rel.startsWith('..')) rel = basename(path) // defensive: path escaped the series dir
  return { relPath: rel, absPath: path, size: fsize, mtime: fmtime, inode: finode }
}
