import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { AdapterError, type Item, type MediaFile, type Tag } from '../arr/types.js'
import { getAdapter } from '../arr/factory.js'
import { normalizeFsFallback, type Settings } from '../config/env.js'
import type { DbClient } from '../db/client.js'
import {
  appFiles,
  appItems,
  apps,
  links,
  rules as rulesTable,
  vocabulary,
} from '../db/schema.js'
import { logEvent } from '../db/events.js'
import { SettingsStore } from '../db/settings-store.js'
import { syncAppTags } from '../db/tags.js'
import { removeLink, resolveFsFallback } from './fsutil.js'
import { reconcile } from './linker.js'
import type { Condition } from './matching.js'
import { planLinks, type PlannerItem, type PlannerRule } from './planner.js'
import { DEFAULT_ROOTS } from './template.js'
import {
  expandVocabularyConditions,
  syncTmdbVocabulary,
  syncTrashVocabulary,
  syncVocabularyRows,
} from './vocabulary.js'

/** Per-app poller: snapshot, diff, and reconcile hardlinks. Ported from core/poller.py.
 * Node has one JS thread, so Python's asyncio.to_thread offload is dropped -- a
 * poll+reconcile just runs inline. Scheduling uses recursive setTimeout (via the
 * sleep() helper) since each loop's delay is dynamic, not fixed. */

const JITTER = 0.2
const MAX_BACKOFF_S = 60
const DELETE_AFTER = 3
// How often the supervisor re-scans the apps table for newly enabled apps.
const TICK_S = 15
// TMDB/TRaSH data is shared per app_type, not per app instance.
const VOCAB_LOOP_S = 24 * 3600
const VOCAB_STALE_S = 7 * 24 * 3600
// Per-instance quality-profile/language lists.
const INSTANCE_VOCAB_STALE_S = 6 * 3600
// Rows kept in the `events` table (a poll writes at least one per cycle).
const EVENTS_RETENTION = 5000
const STORE_COMMIT_BATCH = 500

type AppItemRow = typeof appItems.$inferSelect
type AppFileRow = typeof appFiles.$inferSelect
type RuleRow = typeof rulesTable.$inferSelect

function jitterFactor(): number {
  return (Math.random() * 2 - 1) * JITTER
}

/** Resolves after `ms`, or immediately if `signal` fires first -- never rejects,
 * so callers just check `signal.aborted` after each await instead of try/catch. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

function rowToPlannerRule(row: RuleRow): PlannerRule {
  let conditions: Condition[] = []
  try {
    const parsed: unknown = JSON.parse(row.conditionsJson)
    if (Array.isArray(parsed)) conditions = parsed as Condition[]
  } catch {
    conditions = []
  }
  return {
    id: row.id,
    name: row.name,
    appScope: row.appScope,
    appTypeScope: row.appTypeScope,
    conditions,
    dirTemplate: row.dirTemplate,
    filenameTemplate: row.filenameTemplate,
    enabled: Boolean(row.enabled),
    priority: row.priority,
  }
}

export class Poller {
  private readonly db: DbClient
  private readonly settings: Settings
  private readonly settingsStore: SettingsStore
  private supervisorAbort: AbortController | null = null
  private vocabAbort: AbortController | null = null
  private readonly appLoops = new Map<number, AbortController>()

  constructor(db: DbClient, settings: Settings) {
    this.db = db
    this.settings = settings
    this.settingsStore = new SettingsStore(db)
  }

  // ------------------------------------------------------------------ run

  start(): void {
    this.stop()
    this.supervisorAbort = new AbortController()
    this.vocabAbort = new AbortController()
    void this.supervisorLoop(this.supervisorAbort.signal)
    void this.vocabularyLoop(this.vocabAbort.signal)
  }

  stop(): void {
    this.supervisorAbort?.abort()
    this.vocabAbort?.abort()
    for (const controller of this.appLoops.values()) controller.abort()
    this.appLoops.clear()
    this.supervisorAbort = null
    this.vocabAbort = null
  }

  private async supervisorLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const enabled = this.db.select().from(apps).where(eq(apps.enabled, 1)).all()
      for (const app of enabled) {
        if (this.appLoops.has(app.id)) continue
        const controller = new AbortController()
        this.appLoops.set(app.id, controller)
        void this.appLoop(app.id, controller.signal)
      }
      await sleep(TICK_S * 1000, signal)
    }
  }

  private async appLoop(appId: number, signal: AbortSignal): Promise<void> {
    try {
      let backoff = 0
      while (!signal.aborted) {
        const row = this.db
          .select({ enabled: apps.enabled, pollIntervalS: apps.pollIntervalS })
          .from(apps)
          .where(eq(apps.id, appId))
          .get()
        // Stop (rather than loop forever as a no-op) once the app is disabled or deleted.
        if (row === undefined || !row.enabled) return

        const ok = await this.pollOnce(appId)
        if (signal.aborted) return
        if (ok) {
          backoff = 0
          const base = row.pollIntervalS || 30
          await sleep(base * 1000 * (1 + jitterFactor()), signal)
        } else {
          backoff = Math.min(backoff * 2 || 5, MAX_BACKOFF_S)
          await sleep(backoff * 1000, signal)
        }
      }
    } finally {
      this.appLoops.delete(appId)
    }
  }

  /** Manual rescan -- already async/non-blocking, so no thread-offload needed. */
  async rescan(appId: number): Promise<{ ok: boolean }> {
    const ok = await this.pollOnce(appId)
    return { ok }
  }

  // ------------------------------------------------------- vocabulary sync

  private async vocabularyLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const appTypes = new Set(
          this.db
            .selectDistinct({ type: apps.type })
            .from(apps)
            .where(eq(apps.enabled, 1))
            .all()
            .map((r) => r.type),
        )
        if (this.vocabStale('genre', null) || this.vocabStale('certification', null)) {
          const counts = await syncTmdbVocabulary(this.db, this.settingsStore)
          if (Object.keys(counts).length > 0) {
            logEvent(this.db, 'info', `synced TMDB vocabulary: ${JSON.stringify(counts)}`)
          }
        }
        for (const appType of appTypes) {
          if (this.vocabStale('quality', null, appType, 'trash')) {
            const n = await syncTrashVocabulary(this.db, appType)
            logEvent(this.db, 'info', `synced ${n} TRaSH quality name(s) for ${appType}`)
          }
        }
      } catch (e) {
        console.warn(`vocabulary sync failed: ${String(e)}`)
      }
      try {
        this.pruneEvents()
      } catch (e) {
        console.warn(`event log prune failed: ${String(e)}`)
      }
      await sleep(VOCAB_LOOP_S * 1000, signal)
    }
  }

  private pruneEvents(): void {
    const raw = this.settingsStore.getSetting<number>('events_retention')
    let keep = EVENTS_RETENTION
    if (raw !== undefined) {
      const n = Number(raw)
      keep = Number.isFinite(n) ? Math.max(100, Math.trunc(n)) : EVENTS_RETENTION
    }
    const result = this.db.$client
      .prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) - ? FROM events)')
      .run(keep)
    if (result.changes > 0) console.log(`pruned ${result.changes} old event row(s)`)
  }

  private vocabStale(
    category: string,
    appId: number | null,
    appType?: string,
    source?: string,
    maxAge: number = VOCAB_STALE_S,
  ): boolean {
    const conditions = [
      eq(vocabulary.category, category),
      appId !== null ? eq(vocabulary.appId, appId) : isNull(vocabulary.appId),
    ]
    if (appType !== undefined) conditions.push(eq(vocabulary.appType, appType))
    if (source !== undefined) conditions.push(eq(vocabulary.source, source))
    const row = this.db
      .select({ ts: sql<number | null>`MAX(${vocabulary.importedAt})` })
      .from(vocabulary)
      .where(and(...conditions))
      .get()
    const ts = row?.ts ?? null
    return ts === null || Date.now() / 1000 - ts > maxAge
  }

  /** Per-instance vocabulary: collection names observed in this poll's items (pure
   * derivation, every poll) plus this app's configured quality profiles/languages
   * (2 adapter HTTP calls, throttled to INSTANCE_VOCAB_STALE_S). Best-effort: never
   * fails the poll. */
  private async syncInstanceVocabulary(
    appId: number,
    appType: string,
    items: Item[],
  ): Promise<void> {
    try {
      const collections = [
        ...new Set(items.map((i) => i.collection).filter((c): c is string => Boolean(c))),
      ].sort()
      const stored = new Set(
        this.db
          .select({ value: vocabulary.value })
          .from(vocabulary)
          .where(
            and(
              eq(vocabulary.category, 'collection'),
              eq(vocabulary.appType, appType),
              eq(vocabulary.appId, appId),
              eq(vocabulary.source, 'observed'),
            ),
          )
          .all()
          .map((r) => r.value),
      )
      if (collections.length !== stored.size || collections.some((c) => !stored.has(c))) {
        syncVocabularyRows(
          this.db,
          'collection',
          appType,
          appId,
          collections.map((c): [string, null] => [c, null]),
          'observed',
        )
      }
    } catch (e) {
      console.warn(`collection vocabulary sync failed for app ${appId}: ${String(e)}`)
    }

    const stale =
      this.vocabStale('quality', appId, appType, 'instance', INSTANCE_VOCAB_STALE_S) ||
      this.vocabStale('language', appId, appType, 'instance', INSTANCE_VOCAB_STALE_S)
    if (!stale) return
    try {
      const app = this.db.select().from(apps).where(eq(apps.id, appId)).get()
      if (app === undefined) return
      const adapter = getAdapter(app.type, app.url, app.apiKey)
      const profiles = await adapter.fetchQualityProfiles()
      const languages = await adapter.fetchLanguages()
      syncVocabularyRows(
        this.db,
        'quality',
        appType,
        appId,
        profiles
          .filter((p) => p.name)
          .map((p): [string, string] => [p.name, String(p.id)]),
        'instance',
      )
      syncVocabularyRows(
        this.db,
        'language',
        appType,
        appId,
        languages
          .filter((l) => l.name)
          .map((l): [string, string] => [l.name, String(l.id)]),
        'instance',
      )
    } catch (e) {
      console.warn(`instance vocabulary sync failed for app ${appId}: ${String(e)}`)
    }
  }

  // ------------------------------------------------------------- polling

  /** One poll for one app. Returns true if the app was reachable. */
  private async pollOnce(appId: number): Promise<boolean> {
    const app = this.db.select().from(apps).where(eq(apps.id, appId)).get()
    if (app === undefined || !app.enabled) return true

    const knownFpsRows = this.db
      .select({ itemId: appItems.itemId, statsFingerprint: appItems.statsFingerprint })
      .from(appItems)
      .where(and(eq(appItems.appId, appId), isNotNull(appItems.statsFingerprint)))
      .all()
    const knownFps = new Map<number, string>(
      knownFpsRows.map((r) => [r.itemId, r.statsFingerprint as string]),
    )

    let items: Item[]
    let tags: Tag[]
    try {
      const adapter = getAdapter(app.type, app.url, app.apiKey)
      ;({ items, tags } = await adapter.fetchSnapshot(knownFps))
    } catch (e) {
      const detail = e instanceof AdapterError ? e.detail : String(e)
      const now = Date.now() / 1000
      this.db
        .update(apps)
        .set({ lastError: detail, lastPollAt: now })
        .where(eq(apps.id, appId))
        .run()
      logEvent(this.db, 'warn', `${app.name}: poll failed: ${detail}`, appId)
      return false
    }

    syncAppTags(this.db, appId, tags)
    this.storeItems(appId, items, Date.now() / 1000)
    await this.syncInstanceVocabulary(appId, app.type, items)
    this.reconcileApp(appId, app.name, app.type, items)

    this.db
      .update(apps)
      .set({ lastError: null, lastPollAt: Date.now() / 1000, itemCount: items.length })
      .where(eq(apps.id, appId))
      .run()
    return true
  }

  // -------------------------------------------------------------- storage

  /** Diff the app's reported items/files against what's stored and persist the
   * delta, chunk-committing every STORE_COMMIT_BATCH rows to release the WAL
   * writer lock (mirrors linker.ts's withChunkedCommits). */
  private storeItems(appId: number, items: Item[], now: number): void {
    const itemRowsById = new Map<number, AppItemRow>(
      this.db
        .select()
        .from(appItems)
        .where(eq(appItems.appId, appId))
        .all()
        .map((r) => [r.itemId, r]),
    )
    const filesByItemDbId = new Map<number, AppFileRow[]>()
    for (const { app_files: f } of this.db
      .select({ app_files: appFiles })
      .from(appFiles)
      .innerJoin(appItems, eq(appFiles.itemId, appItems.id))
      .where(eq(appItems.appId, appId))
      .all()) {
      const list = filesByItemDbId.get(f.itemId)
      if (list) list.push(f)
      else filesByItemDbId.set(f.itemId, [f])
    }

    const seenItems = new Set<number>()
    const raw = this.db.$client
    raw.exec('BEGIN')
    try {
      items.forEach((item, i) => {
        if (i > 0 && i % STORE_COMMIT_BATCH === 0) {
          raw.exec('COMMIT')
          raw.exec('BEGIN')
        }
        seenItems.add(item.id)
        this.storeOneItem(appId, item, itemRowsById, filesByItemDbId, now)
      })
      // items no longer reported by the app
      let i = 0
      for (const [itemId, row] of itemRowsById) {
        if (i > 0 && i % STORE_COMMIT_BATCH === 0) {
          raw.exec('COMMIT')
          raw.exec('BEGIN')
        }
        if (!seenItems.has(itemId)) this.strikeMissingItem(row)
        i += 1
      }
      raw.exec('COMMIT')
    } catch (e) {
      raw.exec('ROLLBACK')
      throw e
    }
  }

  private storeOneItem(
    appId: number,
    item: Item,
    itemRowsById: Map<number, AppItemRow>,
    filesByItemDbId: Map<number, AppFileRow[]>,
    now: number,
  ): void {
    const tagsJson = JSON.stringify([...item.tags].sort())
    const genresJson = JSON.stringify([...item.genres].sort())
    const existing = itemRowsById.get(item.id)
    const existingFiles =
      existing !== undefined ? (filesByItemDbId.get(existing.id) ?? []) : []

    // This item's files were NOT re-fetched -- rehydrate them from the stored
    // rows so the planner sees the real file set and the diff below writes
    // nothing. Only healthy rows (missingStrikes == 0): a row mid-grace is
    // deliberately left out so the loop below keeps striking it toward
    // deletion, exactly as a live fetch would. Mutates item.files so
    // reconcileApp (which runs after storeItems, over the same items) sees it.
    if (item.filesStale && existingFiles.length > 0) {
      item.files = existingFiles
        .filter((fr) => (fr.missingStrikes || 0) === 0)
        .map((fr): MediaFile => ({
          relPath: fr.relPath,
          absPath: fr.absPath,
          size: fr.size,
          mtime: fr.mtime,
          inode: fr.inode,
          id: fr.id,
        }))
    }
    const files = item.files

    const statsFp = item.statsFingerprint ?? null
    let itemDbId: number
    if (existing === undefined) {
      const res = this.db
        .insert(appItems)
        .values({
          appId,
          itemId: item.id,
          title: item.title,
          year: item.year,
          tagsJson,
          path: item.path,
          fileCount: files.length,
          firstSeen: now,
          lastSeen: now,
          missingStrikes: 0,
          genresJson,
          certification: item.certification,
          collection: item.collection,
          qualityProfileId: item.qualityProfileId,
          qualityProfileName: item.qualityProfileName,
          originalLanguage: item.originalLanguage,
          statsFingerprint: statsFp,
        })
        .run()
      itemDbId = Number(res.lastInsertRowid)
    } else {
      itemDbId = existing.id
      // only write when something actually changed
      const changed =
        existing.title !== item.title ||
        existing.year !== item.year ||
        existing.tagsJson !== tagsJson ||
        existing.path !== item.path ||
        existing.fileCount !== files.length ||
        existing.genresJson !== genresJson ||
        existing.certification !== item.certification ||
        existing.collection !== item.collection ||
        existing.qualityProfileId !== item.qualityProfileId ||
        existing.qualityProfileName !== item.qualityProfileName ||
        existing.originalLanguage !== item.originalLanguage ||
        existing.statsFingerprint !== statsFp ||
        (existing.missingStrikes || 0) !== 0
      if (changed) {
        this.db
          .update(appItems)
          .set({
            title: item.title,
            year: item.year,
            tagsJson,
            path: item.path,
            fileCount: files.length,
            lastSeen: now,
            missingStrikes: 0,
            genresJson,
            certification: item.certification,
            collection: item.collection,
            qualityProfileId: item.qualityProfileId,
            qualityProfileName: item.qualityProfileName,
            originalLanguage: item.originalLanguage,
            statsFingerprint: statsFp,
          })
          .where(eq(appItems.id, itemDbId))
          .run()
      }
    }

    // --- files: match by rel_path, else by inode (rename) -----------------
    const byRelPath = new Map(existingFiles.map((fr) => [fr.relPath, fr]))
    const byInode = new Map(
      existingFiles
        .filter((fr) => fr.inode !== null)
        .map((fr) => [fr.inode as number, fr]),
    )
    const matchedIds = new Set<number>()

    for (const f of files) {
      let frow = byRelPath.get(f.relPath)
      if (frow === undefined && f.inode !== null) frow = byInode.get(f.inode)

      let fid: number
      if (frow === undefined) {
        const res = this.db
          .insert(appFiles)
          .values({
            itemId: itemDbId,
            relPath: f.relPath,
            absPath: f.absPath,
            size: f.size,
            mtime: f.mtime,
            inode: f.inode,
            missingStrikes: 0,
          })
          .run()
        fid = Number(res.lastInsertRowid)
      } else {
        fid = frow.id
        // a row matched by inode under a different rel_path means the file was
        // renamed/moved: reuse the row so the linker re-links under the new
        // name. Skip the write when nothing about the file changed.
        const changed =
          frow.relPath !== f.relPath ||
          frow.absPath !== f.absPath ||
          frow.size !== f.size ||
          frow.mtime !== f.mtime ||
          frow.inode !== f.inode ||
          (frow.missingStrikes || 0) !== 0
        if (changed) {
          this.db
            .update(appFiles)
            .set({
              relPath: f.relPath,
              absPath: f.absPath,
              size: f.size,
              mtime: f.mtime,
              inode: f.inode,
              missingStrikes: 0,
            })
            .where(eq(appFiles.id, fid))
            .run()
        }
      }
      f.id = fid // backfill so the planner carries it
      matchedIds.add(fid)
    }

    // files no longer reported for this item
    for (const frow of existingFiles) {
      if (!matchedIds.has(frow.id)) this.strikeMissingFile(frow)
    }
  }

  /** One grace strike for a file the app stopped reporting; after DELETE_AFTER
   * misses, unlink its hardlinks and drop the row. */
  private strikeMissingFile(frow: AppFileRow): void {
    const strikes = (frow.missingStrikes || 0) + 1
    if (strikes < DELETE_AFTER) {
      this.db
        .update(appFiles)
        .set({ missingStrikes: strikes })
        .where(eq(appFiles.id, frow.id))
        .run()
      return
    }
    // file gone for good: unlink its hardlinks from disk FIRST (links.file_id is
    // ON DELETE CASCADE, so the delete below would otherwise silently drop the
    // links row -- before reconcileApp ever sees it -- leaking the physical
    // hardlink on disk with zero record of it anywhere).
    const linkRows = this.db
      .select({ dstPath: links.dstPath })
      .from(links)
      .where(and(eq(links.fileId, frow.id), inArray(links.status, ['active', 'stale'])))
      .all()
    for (const lrow of linkRows) {
      const r = removeLink(lrow.dstPath)
      if (r.ok) {
        this.db
          .update(links)
          .set({ status: 'missing', fileId: null })
          .where(eq(links.dstPath, lrow.dstPath))
          .run()
      }
    }
    this.db.delete(appFiles).where(eq(appFiles.id, frow.id)).run()
  }

  /** One grace strike for an item the app stopped reporting; after DELETE_AFTER
   * misses, unlink its hardlinks and drop the row. */
  private strikeMissingItem(row: AppItemRow): void {
    const strikes = (row.missingStrikes || 0) + 1
    if (strikes < DELETE_AFTER) {
      this.db
        .update(appItems)
        .set({ missingStrikes: strikes })
        .where(eq(appItems.id, row.id))
        .run()
      return
    }
    const linkRows = this.db
      .select({ dstPath: links.dstPath })
      .from(links)
      .where(and(eq(links.itemId, row.id), inArray(links.status, ['active', 'stale'])))
      .all()
    for (const lrow of linkRows) {
      const r = removeLink(lrow.dstPath)
      if (r.ok) {
        this.db
          .update(links)
          .set({ status: 'missing', itemId: null, fileId: null })
          .where(eq(links.dstPath, lrow.dstPath))
          .run()
      }
    }
    this.db.delete(appItems).where(eq(appItems.id, row.id)).run()
  }

  // ------------------------------------------------------------- reconcile

  private reconcileApp(
    appId: number,
    appName: string,
    appType: string,
    items: Item[],
  ): void {
    const roots = this.settingsStore.getSetting<string[]>('allowed_roots') ?? [
      ...DEFAULT_ROOTS,
    ]
    let plannerRules = this.db
      .select()
      .from(rulesTable)
      .where(eq(rulesTable.enabled, 1))
      .all()
      .map(rowToPlannerRule)
    plannerRules = expandVocabularyConditions(plannerRules, this.db, appId, appType)

    const plannerItems: PlannerItem[] = items.map((it) => ({
      id: it.id,
      title: it.title,
      year: it.year,
      tags: it.tags,
      genres: it.genres,
      certification: it.certification,
      collection: it.collection,
      qualityProfileName: it.qualityProfileName,
      originalLanguage: it.originalLanguage,
      filesStale: it.filesStale,
      files: it.files.map((f) => ({
        id: f.id ?? null,
        absPath: f.absPath,
        inode: f.inode,
        size: f.size,
      })),
    }))

    const { planned, errors } = planLinks(
      plannerRules,
      plannerItems,
      appName,
      appId,
      roots,
      appType,
    )

    const liveSrcs = new Set<string>()
    for (const item of items) for (const f of item.files) liveSrcs.add(f.absPath)

    for (const e of errors) {
      logEvent(
        this.db,
        'warn',
        `rule '${e.ruleName}' template error for ${e.itemTitle}: ${e.error}`,
        appId,
      )
    }

    const unlinkDefault = this.settingsStore.getSetting<boolean>(
      'global_unlink_on_mismatch',
      true,
    )
    const result = reconcile(
      this.db,
      appId,
      appName,
      planned,
      liveSrcs,
      Boolean(unlinkDefault),
      resolveFsFallback(
        this.settingsStore,
        normalizeFsFallback(this.settings.fsFallback),
      ),
    )
    if (result.created || result.removed || result.moved) {
      logEvent(
        this.db,
        'info',
        `${appName}: +${result.created} -${result.removed} moved ${result.moved}`,
        appId,
      )
    }
    for (const err of result.errors)
      logEvent(this.db, 'warn', `${appName}: ${err}`, appId)
  }
}
