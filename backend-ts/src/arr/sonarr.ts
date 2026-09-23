import { statSync, type Stats } from 'node:fs'
import { basename, relative } from 'node:path'
import { BaseAdapter } from './base.js'
import { scandirStats } from './scandir-stats.js'
import {
  AdapterError,
  mediaInfoValues,
  toNumberOrNull,
  translateTagLabels,
  type AppInfo,
  type Item,
  type MediaFile,
  type MediaInfo,
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
  network?: string
  seriesType?: string
  ratings?: { value?: number } | null
  runtime?: number
}

interface SonarrEpisodeFileRow {
  path?: string
  size?: number
  languages?: Array<{ id?: number; name?: string }>
  mediaInfo?: MediaInfo | null
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
  network: string | null
  seriesType: string | null
  rating: number | null
  runtime: number | null
}

/** A cheap "did this series' file set change" marker from the statistics block --
 * no extra call. Null when absent (poller always re-fetches, never skips). */
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

  protected itemPath(itemId: number): string {
    return `/api/v3/series/${itemId}`
  }

  async ping(): Promise<AppInfo> {
    const data = (await this.getJson('/api/v3/system/status')) as { version?: unknown }
    if (!data || typeof data !== 'object' || !('version' in data)) {
      throw new AdapterError('unexpected system/status payload')
    }
    return { name: 'sonarr', version: String(data.version) }
  }

  async fetchItems(
    knownFingerprints?: Map<number, string>,
    tags?: Tag[],
  ): Promise<Item[]> {
    const known = knownFingerprints ?? new Map<number, string>()

    // series list, quality-profile names, and (unless supplied) tags -- run concurrently.
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
        network: (s.network ?? '').trim() || null,
        seriesType: (s.seriesType ?? '').trim() || null,
        // Sonarr reports one rating value, no per-source (imdb/tmdb) breakdown.
        rating: toNumberOrNull(s.ratings?.value),
        runtime: toNumberOrNull(s.runtime),
      })
    }
    if (meta.size === 0) return []

    // Delta fetch: only pull /episodefile for series with a changed (or missing)
    // fingerprint. Unchanged series come back filesStale=true for the poller to rehydrate.
    const toFetch = [...meta.entries()]
      .filter(
        ([sid, m]) =>
          m.statsFingerprint === null || known.get(sid) !== m.statsFingerprint,
      )
      .map(([sid]) => sid)

    type FetchedFiles = {
      files: MediaFile[]
      audioLanguages: string[]
      videoCodec: string[]
      videoDynamicRange: string[]
      audioCodec: string[]
      audioChannels: string[]
    }

    const fetchedEntries = await mapWithConcurrency(
      toFetch,
      FILE_FETCH_CONCURRENCY,
      async (sid): Promise<[number, FetchedFiles]> => {
        const data = await this.getJson(`/api/v3/episodefile?seriesId=${sid}`)
        if (!Array.isArray(data)) {
          throw new AdapterError(`unexpected episodefile payload for series ${sid}`)
        }
        const seriesPath = meta.get(sid)!.path
        const rows = data as SonarrEpisodeFileRow[]
        const specs = rows
          .filter((f) => f && typeof f === 'object' && f.path)
          .map((f) => ({ path: String(f.path), size: f.size }))

        // One directory listing per season folder instead of one stat per file.
        const stats = scandirStats(specs.map((s) => s.path))
        const files = specs.map((s) =>
          statFile(s.path, seriesPath, s.size, stats.get(s.path)),
        )
        // Union of every episode file's audio track(s)/mediaInfo -- a series'
        // episodes aren't guaranteed to share one dub/language/encode mix.
        const audioLanguages = [
          ...new Set(
            rows.flatMap((f) =>
              (Array.isArray(f.languages) ? f.languages : [])
                .map((l) => l?.name?.trim())
                .filter((n): n is string => Boolean(n)),
            ),
          ),
        ]
        const media = rows.map((f) => mediaInfoValues(f.mediaInfo))
        const unionOf = (key: keyof ReturnType<typeof mediaInfoValues>): string[] => [
          ...new Set(media.flatMap((m) => m[key])),
        ]
        return [
          sid,
          {
            files,
            audioLanguages,
            videoCodec: unionOf('videoCodec'),
            videoDynamicRange: unionOf('videoDynamicRange'),
            audioCodec: unionOf('audioCodec'),
            audioChannels: unionOf('audioChannels'),
          },
        ]
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
        network: m.network,
        seriesType: m.seriesType,
        rating: m.rating,
        popularity: null, // no Sonarr equivalent
        runtime: m.runtime,
      }
      if (fetched.has(sid)) {
        const {
          files: itemFiles,
          audioLanguages,
          videoCodec,
          videoDynamicRange,
          audioCodec,
          audioChannels,
        } = fetched.get(sid)!
        if (itemFiles.length === 0) continue // series with no files on disk
        items.push({
          ...common,
          files: itemFiles,
          audioLanguages,
          videoCodec,
          videoDynamicRange,
          audioCodec,
          audioChannels,
          filesStale: false,
        })
      } else {
        // unchanged -- poller rehydrates files (and audioLanguages/mediaInfo) from stored rows.
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
