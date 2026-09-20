import {
  AdapterError,
  type AppInfo,
  type Item,
  type Language,
  type QualityProfile,
  type Tag,
} from './types.js'

const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Common contract for *arr app adapters. Subclasses set `appType` and
 * implement the abstract methods below. All methods throw AdapterError on
 * provider failures.
 *
 * Unlike the Python version's explicit `_session()` pooled-httpx-client
 * context manager, this port relies on Node's global `fetch` (undici),
 * which already keep-alives connections per origin by default -- see the
 * plan's "arr/ adapters" section for why the explicit pooling is dropped
 * rather than ported.
 */
export abstract class BaseAdapter {
  abstract readonly appType: 'radarr' | 'sonarr'

  protected readonly url: string
  protected readonly apiKey: string
  protected readonly timeoutMs: number

  constructor(url: string, apiKey: string, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.url = (url || '').replace(/\/+$/, '')
    this.apiKey = apiKey
    this.timeoutMs = timeoutMs
  }

  abstract ping(): Promise<AppInfo>
  abstract fetchTags(): Promise<Tag[]>
  abstract fetchItems(
    knownFingerprints?: Map<number, string>,
    tags?: Tag[],
  ): Promise<Item[]>

  /**
   * Items + the tag vocabulary in one call -- what the poller needs each
   * cycle. Avoids fetching /v3/tag twice (once here, once inside
   * fetchItems for id->label translation).
   */
  async fetchSnapshot(
    knownFingerprints?: Map<number, string>,
  ): Promise<{ items: Item[]; tags: Tag[] }> {
    const tags = await this.fetchTags()
    const items = await this.fetchItems(knownFingerprints, tags)
    return { items, tags }
  }

  /**
   * Create a tag in the app (idempotent). Default: unsupported. Used by
   * the tag repository's *push to app*. Radarr/Sonarr override.
   */
  createTag(_label: string): Promise<void> {
    return Promise.reject(
      new AdapterError(`create_tag not supported for ${this.appType}`),
    )
  }

  /**
   * This instance's configured quality profiles. Radarr and Sonarr both
   * expose the identical `[{id, name}]` shape at this path, so one shared
   * implementation covers both.
   */
  async fetchQualityProfiles(): Promise<QualityProfile[]> {
    const data = await this.getJson('/api/v3/qualityprofile')
    if (!Array.isArray(data)) throw new AdapterError('unexpected qualityprofile payload')
    const out: QualityProfile[] = []
    for (const r of data as unknown[]) {
      const row = asIdNameRow(r)
      if (row) out.push(row)
    }
    return out
  }

  /**
   * `{id: name}` for this instance's quality profiles, or `{}` if the app
   * doesn't expose /qualityprofile -- profile *names* aren't on the
   * movie/series rows, only the id, so fetchItems resolves them. Tolerant
   * so it can be gathered alongside the item list.
   */
  async qualityProfileNames(): Promise<Map<number, string>> {
    try {
      const profiles = await this.fetchQualityProfiles()
      return new Map(profiles.map((p) => [p.id, p.name]))
    } catch (e) {
      if (e instanceof AdapterError) return new Map()
      throw e
    }
  }

  /** This instance's known languages. Same shared-implementation rationale as fetchQualityProfiles. */
  async fetchLanguages(): Promise<Language[]> {
    const data = await this.getJson('/api/v3/language')
    if (!Array.isArray(data)) throw new AdapterError('unexpected language payload')
    const out: Language[] = []
    for (const r of data as unknown[]) {
      const row = asIdNameRow(r)
      if (row) out.push(row)
    }
    return out
  }

  protected async getJson(path: string): Promise<unknown> {
    if (!this.url) throw new AdapterError('app url is empty')
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.timeoutMs)
    let r: Response
    try {
      r = await fetch(`${this.url}${path}`, {
        headers: { 'X-Api-Key': this.apiKey },
        signal: controller.signal,
      })
    } catch (e) {
      throw new AdapterError(`unreachable: ${String(e)}`)
    } finally {
      clearTimeout(timer)
    }
    if (r.status === 401 || r.status === 403) {
      throw new AdapterError('bad API key (401)', 401)
    }
    if (r.status !== 200) {
      throw new AdapterError(`HTTP ${r.status} from ${path}`, r.status)
    }
    try {
      return await r.json()
    } catch {
      throw new AdapterError(`non-JSON response from ${path}`)
    }
  }

  protected async postJson(path: string, body: unknown): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.timeoutMs)
    try {
      return await fetch(`${this.url}${path}`, {
        method: 'POST',
        headers: { 'X-Api-Key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (e) {
      throw new AdapterError(`unreachable: ${String(e)}`)
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Narrows an unknown JSON row to `{id, name}` the way fetchQualityProfiles/fetchLanguages need. */
function asIdNameRow(r: unknown): { id: number; name: string } | null {
  if (!r || typeof r !== 'object') return null
  const row = r as { id?: unknown; name?: unknown }
  if (row.id === null || row.id === undefined) return null
  const name = typeof row.name === 'string' ? row.name : ''
  return { id: Number(row.id), name }
}
