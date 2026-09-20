import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AdapterError } from '../arr/types.js'
import { getAdapter } from '../arr/factory.js'
import type { Settings } from '../config/env.js'
import type { DbClient } from '../db/client.js'
import { logEvent } from '../db/events.js'
import {
  appItems,
  apps,
  rules as rulesTable,
  tagRepository,
  tags as tagsTable,
} from '../db/schema.js'
import { syncAppTags } from '../db/tags.js'
import type { SettingsStore } from '../db/settings-store.js'
import { ruleAppliesToApp } from '../core/planner.js'
import { HttpError } from '../http-error.js'
import { getCurrentUser } from './auth.js'

/** Tags per app + a shared tag repository. Ported from api/tags.py. */

export interface TagsRouteOptions {
  db: DbClient
  settingsStore: SettingsStore
  env: Settings
}

type TagRow = typeof tagsTable.$inferSelect
type RuleRow = typeof rulesTable.$inferSelect

const CLASSIFIABLE_CATEGORIES = new Set([
  'genre',
  'certification',
  'collection',
  'quality',
  'language',
  'user',
  'custom',
])

const TagImportSchema = z.object({
  labels: z.array(z.string()).min(1).max(500),
  counts: z.record(z.string(), z.number()).default({}),
})

const TagCategorySchema = z.object({
  category: z.string().nullable().default(null),
})

const TagInSchema = z.object({ label: z.string().min(1).max(100) })
const TagPushSchema = z.object({
  label: z.string().min(1).max(100),
  appIds: z.array(z.number().int()).min(1).max(50),
})

function conditionMatchesLabel(
  matchType: string,
  matchValue: string,
  label: string,
): boolean {
  if (matchType === 'exact') return matchValue.trim() === label
  if (matchType === 'list') {
    return matchValue
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(label)
  }
  if (matchType === 'regex') {
    try {
      return new RegExp(matchValue).test(label)
    } catch {
      return false
    }
  }
  return false
}

/** Best-effort UI hint -- checks each matcher in isolation, not the full AND/OR chain. */
function ruleMatchesLabel(rule: RuleRow, label: string): boolean {
  let conditions: Array<{ matchType: string; matchValue: string }> = []
  try {
    const parsed: unknown = JSON.parse(rule.conditionsJson)
    if (Array.isArray(parsed)) conditions = parsed as typeof conditions
  } catch {
    conditions = []
  }
  return conditions.some((c) => conditionMatchesLabel(c.matchType, c.matchValue, label))
}

/** Attach the live-computed "in use" count and rule_count to raw tags-table rows. */
function enrichTags(
  db: DbClient,
  appId: number,
  appType: string,
  tags: TagRow[],
): Record<string, unknown>[] {
  const hasItems = db
    .select({ id: appItems.id })
    .from(appItems)
    .where(eq(appItems.appId, appId))
    .limit(1)
    .get()
  let usage: Map<string, number> | null = null
  if (hasItems) {
    usage = new Map()
    const rows = db
      .select({ tagsJson: appItems.tagsJson })
      .from(appItems)
      .where(eq(appItems.appId, appId))
      .all()
    for (const r of rows) {
      let labels: unknown[]
      try {
        labels = JSON.parse(r.tagsJson) as unknown[]
      } catch {
        labels = []
      }
      for (const l of labels) {
        if (typeof l === 'string') usage.set(l, (usage.get(l) ?? 0) + 1)
      }
    }
  }

  const rules = db
    .select()
    .from(rulesTable)
    .where(eq(rulesTable.enabled, 1))
    .all()
    .filter((r) => ruleAppliesToApp(r, appId, appType))

  return tags.map((t) => ({
    ...t,
    count: usage !== null ? (usage.get(t.label) ?? 0) : t.count,
    ruleCount: rules.filter((r) => ruleMatchesLabel(r, t.label)).length,
  }))
}

export function registerTagsRoutes(app: FastifyInstance, opts: TagsRouteOptions): void {
  const { db, settingsStore, env } = opts

  app.get('/api/apps/:appId/tags', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const appId = Number((request.params as { appId: string }).appId)
    const appRow = db
      .select({ type: apps.type })
      .from(apps)
      .where(eq(apps.id, appId))
      .get()
    if (!appRow) throw new HttpError(404, 'app not found')
    const rows = db
      .select()
      .from(tagsTable)
      .where(eq(tagsTable.appId, appId))
      .orderBy(tagsTable.label)
      .all()
    return enrichTags(db, appId, appRow.type, rows)
  })

  app.patch('/api/apps/:appId/tags/:tagId/category', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const params = request.params as { appId: string; tagId: string }
    const appId = Number(params.appId)
    const tagId = Number(params.tagId)
    const appRow = db
      .select({ type: apps.type })
      .from(apps)
      .where(eq(apps.id, appId))
      .get()
    if (!appRow) throw new HttpError(404, 'app not found')
    const parsed = TagCategorySchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    const { category } = parsed.data
    if (category !== null && !CLASSIFIABLE_CATEGORIES.has(category)) {
      throw new HttpError(422, `unknown category '${category}'`)
    }
    const row = db
      .select({ id: tagsTable.id })
      .from(tagsTable)
      .where(eq(tagsTable.id, tagId))
      .get()
    if (!row || row.id === undefined) throw new HttpError(404, 'tag not found')
    db.update(tagsTable).set({ category }).where(eq(tagsTable.id, tagId)).run()
    const tag = db.select().from(tagsTable).where(eq(tagsTable.id, tagId)).get()!
    return enrichTags(db, appId, appRow.type, [tag])[0]
  })

  app.post('/api/apps/:appId/tags/import', async (request, reply) => {
    getCurrentUser(request, db, settingsStore, env)
    const appId = Number((request.params as { appId: string }).appId)
    const row = db.select().from(apps).where(eq(apps.id, appId)).get()
    if (!row) throw new HttpError(404, 'app not found')
    let count: number
    try {
      const adapter = getAdapter(row.type, row.url, row.apiKey)
      const tags = await adapter.fetchTags()
      count = syncAppTags(db, appId, tags)
    } catch (e) {
      const detail = e instanceof AdapterError ? e.detail : String(e)
      db.update(apps).set({ lastError: detail }).where(eq(apps.id, appId)).run()
      logEvent(db, 'warn', `tag import failed for ${row.name}: ${detail}`, appId)
      throw new HttpError(502, detail)
    }
    db.update(apps).set({ lastError: null }).where(eq(apps.id, appId)).run()
    logEvent(db, 'info', `imported ${count} tag(s) from ${row.name}`, appId)
    reply.code(201)
    return { imported: count }
  })

  app.post('/api/apps/:appId/tags/import-manual', (request, reply) => {
    getCurrentUser(request, db, settingsStore, env)
    const appId = Number((request.params as { appId: string }).appId)
    if (!db.select({ id: apps.id }).from(apps).where(eq(apps.id, appId)).get()) {
      throw new HttpError(404, 'app not found')
    }
    const parsed = TagImportSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    const body = parsed.data
    const ts = Date.now() / 1000
    for (const raw of body.labels) {
      const label = raw.trim()
      if (!label) continue
      db.insert(tagsTable)
        .values({ appId, label, count: body.counts[label] ?? 0, importedAt: ts })
        .onConflictDoUpdate({
          target: [tagsTable.appId, tagsTable.label],
          set: { count: body.counts[label] ?? 0, importedAt: ts },
        })
        .run()
    }
    logEvent(db, 'info', `imported ${body.labels.length} tag(s) for app ${appId}`, appId)
    reply.code(201)
    return { imported: body.labels.length }
  })

  // -- tag repository -----------------------------------------------------

  app.get('/api/tags', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    return db.select().from(tagRepository).orderBy(tagRepository.label).all()
  })

  app.put('/api/tags', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const parsed = TagInSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    const label = parsed.data.label.trim()
    if (!label) throw new HttpError(422, 'label must not be empty')
    db.insert(tagRepository)
      .values({ label })
      .onConflictDoNothing({ target: tagRepository.label })
      .run()
    return db.select().from(tagRepository).where(eq(tagRepository.label, label)).get()
  })

  app.delete('/api/tags/:label', (request, reply) => {
    getCurrentUser(request, db, settingsStore, env)
    const label = (request.params as { label: string }).label
    const res = db.delete(tagRepository).where(eq(tagRepository.label, label)).run()
    if (res.changes === 0) throw new HttpError(404, 'tag not in repository')
    reply.code(204).send()
  })

  app.post('/api/tags/push', async (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const parsed = TagPushSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    const label = parsed.data.label.trim()
    const results: Array<{ appId: number; ok: boolean; detail: string | null }> = []
    let ok = 0
    let failed = 0
    for (const appId of [...new Set(parsed.data.appIds)]) {
      const row = db.select().from(apps).where(eq(apps.id, appId)).get()
      if (!row) {
        results.push({ appId, ok: false, detail: 'app not found' })
        failed += 1
        continue
      }
      const adapter = getAdapter(row.type, row.url, row.apiKey)
      try {
        await adapter.createTag(label)
      } catch (e) {
        const detail = e instanceof AdapterError ? e.detail : String(e)
        results.push({ appId, ok: false, detail })
        failed += 1
        continue
      }
      try {
        const tags = await adapter.fetchTags()
        syncAppTags(db, appId, tags)
        db.update(apps).set({ lastError: null }).where(eq(apps.id, appId)).run()
        results.push({ appId, ok: true, detail: null })
        ok += 1
      } catch (e) {
        results.push({
          appId,
          ok: true,
          detail: `created, but re-import failed: ${String(e)}`,
        })
        ok += 1
      }
    }
    logEvent(db, 'info', `pushed tag '${label}' to ${ok} app(s) (${failed} failed)`)
    return { label, ok, failed, results }
  })
}
