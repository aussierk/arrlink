import { and, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AdapterError } from '../arr/types.js'
import { getAdapter } from '../arr/factory.js'
import type { Settings } from '../config/env.js'
import type { DbClient } from '../db/client.js'
import { logEvent } from '../db/events.js'
import { appItems, tagRepository } from '../db/schema.js'
import { syncAppTags } from '../db/tags.js'
import type { SettingsStore } from '../db/settings-store.js'
import { HttpError } from '../http-error.js'
import { getCurrentUser } from './auth.js'
import { requireApp } from './require-app.js'

/** Browse an app's media items and write tags back to the live Radarr/Sonarr
 * instance (create/apply/remove) -- distinct from api/tags.ts, which only
 * manages tag *vocabulary* (the shared repository and each app's tag list),
 * never which tags are actually on a given movie/series. */

export interface ItemsRouteOptions {
  db: DbClient
  settingsStore: SettingsStore
  env: Settings
}

type ItemRow = typeof appItems.$inferSelect

const ItemsTagsSchema = z.object({
  item_ids: z.array(z.number().int()).min(1).max(500),
  add: z.array(z.string().min(1).max(100)).default([]),
  remove: z.array(z.string().min(1).max(100)).default([]),
})

function itemOut(row: ItemRow): Record<string, unknown> {
  let tags: string[]
  try {
    tags = JSON.parse(row.tagsJson) as string[]
  } catch {
    tags = []
  }
  return { id: row.id, item_id: row.itemId, title: row.title, year: row.year, tags }
}

export function registerItemsRoutes(app: FastifyInstance, opts: ItemsRouteOptions): void {
  const { db, settingsStore, env } = opts

  app.get('/api/apps/:appId/items', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const appId = Number((request.params as { appId: string }).appId)
    requireApp(db, appId)
    const rows = db
      .select()
      .from(appItems)
      .where(eq(appItems.appId, appId))
      .orderBy(appItems.title)
      .all()
    return rows.map(itemOut)
  })

  app.post('/api/apps/:appId/items/tags', async (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const appId = Number((request.params as { appId: string }).appId)
    const row = requireApp(db, appId)
    const parsed = ItemsTagsSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    const { item_ids: itemIds, add, remove } = parsed.data
    if (add.length === 0 && remove.length === 0) {
      throw new HttpError(422, 'add or remove must not both be empty')
    }

    const items = db
      .select()
      .from(appItems)
      .where(and(eq(appItems.appId, appId), inArray(appItems.id, itemIds)))
      .all()
    const foundIds = new Set(items.map((r) => r.id))

    const adapter = getAdapter(row.type, row.url, row.apiKey)

    // Resolve tag labels -> this app's real numeric tag ids once, up front --
    // creating any of the `add` labels that don't exist on this app yet
    // (Radarr/Sonarr's tags endpoint is idempotent, so no need to check first).
    let vocabulary = await adapter.fetchTags()
    let labelToId = new Map(vocabulary.filter((t) => t.id !== null).map((t) => [t.label, t.id as number]))
    const missing = add.filter((label) => !labelToId.has(label))
    if (missing.length > 0) {
      for (const label of missing) {
        await adapter.createTag(label)
        // New in the shared repository too -- same as PUT /api/tags -- so it's
        // an immediate suggestion for other items/apps, not just this app.
        db.insert(tagRepository).values({ label }).onConflictDoNothing({ target: tagRepository.label }).run()
      }
      vocabulary = await adapter.fetchTags()
      labelToId = new Map(vocabulary.filter((t) => t.id !== null).map((t) => [t.label, t.id as number]))
      syncAppTags(db, appId, vocabulary)
    }

    const results: Array<{ item_id: number; ok: boolean; detail: string | null }> = []
    let ok = 0
    let failed = 0
    for (const itemDbId of itemIds) {
      if (!foundIds.has(itemDbId)) {
        results.push({ item_id: itemDbId, ok: false, detail: 'item not found' })
        failed += 1
        continue
      }
      const item = items.find((r) => r.id === itemDbId)!
      let currentLabels: string[]
      try {
        currentLabels = JSON.parse(item.tagsJson) as string[]
      } catch {
        currentLabels = []
      }
      const nextLabels = Array.from(
        new Set([...currentLabels, ...add].filter((l) => !remove.includes(l))),
      )
      const tagIds = nextLabels
        .map((l) => labelToId.get(l))
        .filter((id): id is number => id !== undefined)
      try {
        await adapter.setItemTags(item.itemId, tagIds)
        db.update(appItems)
          .set({ tagsJson: JSON.stringify(nextLabels) })
          .where(eq(appItems.id, itemDbId))
          .run()
        results.push({ item_id: itemDbId, ok: true, detail: null })
        ok += 1
      } catch (e) {
        const detail = e instanceof AdapterError ? e.detail : String(e)
        results.push({ item_id: itemDbId, ok: false, detail })
        failed += 1
      }
    }
    logEvent(
      db,
      'info',
      `applied tag changes to ${ok} item(s) for ${row.name} (${failed} failed)`,
      appId,
    )
    return { ok, failed, results }
  })
}
