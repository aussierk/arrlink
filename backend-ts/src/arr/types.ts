/** Safe string coercion for untyped JSON fields -- unlike `String(x)`, never
 * stringifies an object/array to "[object Object]"; treats non-strings as absent. */
export function asStr(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export interface AppInfo {
  name: string
  version: string
}

/** One tag from the app's vocabulary. Item payloads reference tags by `id`
 * (a list of ints), so adapters must translate ids -> labels before exposing items. */
export interface Tag {
  label: string
  count: number
  id: number | null
}

export interface MediaFile {
  relPath: string
  absPath: string
  size: number | null
  mtime: number | null
  inode: number | null
  /** app_files.id once stored (used by the linker). */
  id?: number | null
}

/** One quality profile configured on the app instance (`GET /v3/qualityprofile`) --
 * instance-specific, not a universal list. */
export interface QualityProfile {
  id: number
  name: string
}

/** One language known to the app instance (`GET /v3/language`). */
export interface Language {
  id: number
  name: string
}

export interface Item {
  id: number
  title: string
  year: number | null
  tags: string[]
  path: string
  files: MediaFile[]
  /** Read straight from the app's own movie/series payload, independent of the tags system. */
  genres: string[]
  certification: string | null
  /** Collection *name*; Sonarr has none. */
  collection: string | null
  qualityProfileId: number | null
  qualityProfileName: string | null
  originalLanguage: string | null
  /** The downloaded file's own audio track language(s) -- distinct from
   * originalLanguage (the title's production language): a foreign film with
   * an English dub, or multiple audio tracks, means these can differ.
   * undefined (not []) means "not refetched this poll" (Sonarr's delta-fetch
   * skip) -- the poller keeps the last stored value instead of clearing it. */
  audioLanguages?: string[]
  statsFingerprint?: string | null
  filesStale?: boolean
  /** app_items.id once stored -- distinct from `id` (the adapter's external
   * item id). Backfilled by poller.ts's storeOneItem, same pattern as
   * MediaFile.id, and is what the planner must use for links.item_id (an FK
   * to app_items.id, not to the external id). */
  dbId?: number
}

/** Adapter-level failure; carries a user-facing detail. */
export class AdapterError extends Error {
  constructor(
    public readonly detail: string,
    public readonly status: number | null = null,
  ) {
    super(detail)
  }
}

/** Translate a list of *arr tag ids into tag labels via the app's tag vocabulary. */
export function translateTagLabels(tags: Tag[], raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) return []
  const byId = new Map<number, string>()
  for (const t of tags) {
    if (t.id !== null) byId.set(t.id, t.label)
  }
  const out: string[] = []
  for (const t of raw) {
    if (typeof t === 'string') {
      const s = t.trim()
      if (/^\d+$/.test(s)) {
        const label = byId.get(Number(s))
        if (label !== undefined) out.push(label)
      } else if (s) {
        out.push(s)
      }
      continue
    }
    const n = typeof t === 'number' ? t : Number(t)
    if (!Number.isFinite(n)) continue
    const label = byId.get(n)
    if (label !== undefined) out.push(label)
  }
  return out
}
