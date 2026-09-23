import { statSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { BaseAdapter } from './base.js'
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

interface RadarrMovieFile {
  path?: string
  size?: number
  languages?: Array<{ id?: number; name?: string }>
  mediaInfo?: MediaInfo | null
}

interface RadarrMovieRow {
  id: number
  title?: string
  year?: number
  tags?: unknown
  movieFile?: RadarrMovieFile | null
  genres?: unknown
  certification?: string
  collection?: { title?: string; name?: string } | null
  qualityProfileId?: number | null
  originalLanguage?: { name?: string } | null
  studio?: string
  ratings?: {
    imdb?: { value?: number } | null
    tmdb?: { value?: number } | null
  } | null
  popularity?: number
  runtime?: number
}

export class RadarrAdapter extends BaseAdapter {
  readonly appType = 'radarr' as const

  protected itemPath(itemId: number): string {
    return `/api/v3/movie/${itemId}`
  }

  async ping(): Promise<AppInfo> {
    const data = (await this.getJson('/api/v3/system/status')) as { version?: unknown }
    if (!data || typeof data !== 'object' || !('version' in data)) {
      throw new AdapterError('unexpected system/status payload')
    }
    return { name: 'radarr', version: String(data.version) }
  }

  async fetchItems(
    _knownFingerprints?: Map<number, string>,
    tags?: Tag[],
  ): Promise<Item[]> {
    // known_fingerprints is accepted for interface parity and ignored:
    // Radarr's item list is a single /movie call.
    const [data, profileById, vocabulary] = await Promise.all([
      this.getJson('/api/v3/movie'),
      this.qualityProfileNames(),
      tags ? Promise.resolve(tags) : this.fetchTags(),
    ])
    if (!Array.isArray(data)) throw new AdapterError('unexpected movie payload')

    const items: Item[] = []
    for (const row of data as RadarrMovieRow[]) {
      if (!row || typeof row !== 'object') continue
      const movieFile = row.movieFile ?? {}
      const path = movieFile.path
      if (!path) continue // not on disk yet

      const labels = translateTagLabels(vocabulary, row.tags)
      const year = toNumberOrNull(row.year)
      const genres = (Array.isArray(row.genres) ? row.genres : [])
        .map((g) => String(g).trim())
        .filter(Boolean)
      const certification = (row.certification ?? '').trim() || null
      const collection = (row.collection?.title ?? row.collection?.name)?.trim() || null
      const qpId = toNumberOrNull(row.qualityProfileId)
      const qpName = qpId !== null ? (profileById.get(qpId) ?? null) : null
      const originalLanguage = row.originalLanguage?.name?.trim() || null
      // movieFile.languages is the file's own audio track(s), always present
      // alongside movieFile.path/size in the same /movie payload -- no extra call.
      const audioLanguages = (
        Array.isArray(movieFile.languages) ? movieFile.languages : []
      )
        .map((l) => l?.name?.trim())
        .filter((n): n is string => Boolean(n))
      const studio = (row.studio ?? '').trim() || null
      const media = mediaInfoValues(movieFile.mediaInfo)
      const rating = toNumberOrNull(row.ratings?.imdb?.value ?? row.ratings?.tmdb?.value)
      const popularity = toNumberOrNull(row.popularity)
      const runtime = toNumberOrNull(row.runtime)
      const apiSize = toNumberOrNull(movieFile.size)

      const itemDir = dirname(path)
      // Stat the file so the poller can track inodes (Radarr's API doesn't
      // expose them); the container sees the same paths.
      let fsize = apiSize
      let fmtime: number | null = null
      let finode: number | null = null
      try {
        const st = statSync(path)
        fsize = st.size
        fmtime = st.mtimeMs / 1000
        finode = st.ino
      } catch {
        // file not visible from this process -- keep the API-reported size
      }

      const file: MediaFile = {
        relPath: relative(itemDir || '/', path),
        absPath: String(path),
        size: fsize,
        mtime: fmtime,
        inode: finode,
      }

      items.push({
        id: Number(row.id),
        title: String(row.title ?? ''),
        year,
        tags: labels,
        path: itemDir,
        files: [file],
        genres,
        certification,
        collection,
        qualityProfileId: qpId,
        qualityProfileName: qpName,
        originalLanguage,
        audioLanguages,
        studio,
        ...media,
        rating,
        popularity,
        runtime,
      })
    }
    return items
  }
}
