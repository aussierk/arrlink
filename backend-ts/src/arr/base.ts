import {
  AdapterError,
  asStr,
  toNumberOrNull,
  type AppInfo,
  type Item,
  type Language,
  type QualityProfile,
  type Tag,
} from './types.js'

const DEFAULT_TIMEOUT_MS = 15_000

/** Common contract for *arr app adapters. Subclasses set `appType` and implement
 * the abstract methods; all methods throw AdapterError on provider failures.
 * No explicit connection pooling (unlike Python's httpx session) -- Node's
 * global `fetch` already keep-alives per origin. */
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
  abstract fetchItems(
    knownFingerprints?: Map<number, string>,
    tags?: Tag[],
  ): Promise<Item[]>

  /** `/api/v3/movie/{id}` (Radarr) or `/api/v3/series/{id}` (Sonarr) -- the
   * single-item detail/update path setItemTags PUTs the full object back to. */
  protected abstract itemPath(itemId: number): string

  /** Items + tag vocabulary in one call -- avoids fetching /v3/tag twice
   * (here, and again inside fetchItems for id->label translation). */
  async fetchSnapshot(
    knownFingerprints?: Map<number, string>,
  ): Promise<{ items: Item[]; tags: Tag[] }> {
    const tags = await this.fetchTags()
    const items = await this.fetchItems(knownFingerprints, tags)
    return { items, tags }
  }

  /** Radarr and Sonarr expose the identical `[{id, count, label}]` tag shape. */
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

  /** Create a tag in the app (idempotent). Radarr and Sonarr share the same
   * `/api/v3/tag` POST contract. */
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

  /** This instance's configured quality profiles -- Radarr and Sonarr expose the
   * identical `[{id, name}]` shape, so one implementation covers both. */
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

  /** `{id: name}` for this instance's quality profiles, or empty if unsupported --
   * profile names aren't on the movie/series rows, only the id. */
  async qualityProfileNames(): Promise<Map<number, string>> {
    try {
      const profiles = await this.fetchQualityProfiles()
      return new Map(profiles.map((p) => [p.id, p.name]))
    } catch (e) {
      if (e instanceof AdapterError) return new Map()
      throw e
    }
  }

  /** Sets a single item's full tag list on the live app. Radarr/Sonarr's PUT
   * contract replaces the entire movie/series object -- there's no partial-
   * update endpoint -- so this fetches the current object and PUTs it back
   * with only `tags` changed. `tagIds` must already be resolved to this app's
   * real numeric tag ids (see api/items.ts, which creates any missing tags
   * first). */
  async setItemTags(itemId: number, tagIds: number[]): Promise<void> {
    const path = this.itemPath(itemId)
    const current = await this.getJson(path)
    if (!current || typeof current !== 'object') {
      throw new AdapterError(`unexpected item payload from ${path}`)
    }
    const r = await this.putJson(path, { ...current, tags: tagIds })
    if (r.status === 401 || r.status === 403)
      throw new AdapterError('bad API key (401)', 401)
    if (r.status !== 200 && r.status !== 202) {
      throw new AdapterError(`HTTP ${r.status} updating tags for item ${itemId}`, r.status)
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
    return this.sendJson('POST', path, body)
  }

  protected async putJson(path: string, body: unknown): Promise<Response> {
    return this.sendJson('PUT', path, body)
  }

  private async sendJson(method: 'POST' | 'PUT', path: string, body: unknown): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.timeoutMs)
    try {
      return await fetch(`${this.url}${path}`, {
        method,
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
