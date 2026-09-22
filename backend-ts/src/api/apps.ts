import { and, count, eq, inArray } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AdapterError } from '../arr/types.js'
import { getAdapter } from '../arr/factory.js'
import type { Settings } from '../config/env.js'
import type { DbClient } from '../db/client.js'
import { logEvent } from '../db/events.js'
import { apps, links, rules as rulesTable } from '../db/schema.js'
import type { SettingsStore } from '../db/settings-store.js'
import { forceUnlinkAppLinks } from '../core/linker.js'
import type { Poller } from '../core/poller.js'
import { DEFAULT_ROOTS, auditRuleRoots } from '../core/template.js'
import { HttpError } from '../http-error.js'
import { getCurrentUser } from './auth.js'

/** Apps CRUD: storage, connection tests, and tag import. Ported from api/apps.py.
 * Wire format is snake_case throughout, matching web/ and the Python backend. */

type AppRow = typeof apps.$inferSelect

export interface AppsRouteOptions {
  db: DbClient
  settingsStore: SettingsStore
  env: Settings
  getPoller: () => Poller | null
}

const AppInSchema = z.object({
  name: z.string().min(1).max(50),
  type: z.enum(['radarr', 'sonarr']),
  url: z.string().min(4).max(200),
  // Blank on update keeps the existing key; required non-empty on create.
  api_key: z.string().max(200).default(''),
  enabled: z.boolean().default(true),
  poll_interval_s: z.number().int().min(10).max(3600).default(300),
})

function normalizeUrl(v: string): string {
  const trimmed = v.trim()
  const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}

function appOut(row: AppRow): Record<string, unknown> {
  const key = row.apiKey || ''
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    url: row.url,
    enabled: Boolean(row.enabled),
    poll_interval_s: row.pollIntervalS,
    last_poll_at: row.lastPollAt,
    last_error: row.lastError,
    item_count: row.itemCount,
    created_at: row.createdAt,
    api_key_masked: key.length > 4 ? `••••${key.slice(-4)}` : '••••',
  }
}

export function registerAppsRoutes(app: FastifyInstance, opts: AppsRouteOptions): void {
  const { db, settingsStore, env, getPoller } = opts

  app.get('/api/apps', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    return db.select().from(apps).orderBy(apps.id).all().map(appOut)
  })

  app.get('/api/apps/summary', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const active = db
      .select({ c: count() })
      .from(links)
      .where(eq(links.status, 'active'))
      .get()
    const stale = db
      .select({ c: count() })
      .from(links)
      .where(eq(links.status, 'stale'))
      .get()
    const missing = db
      .select({ c: count() })
      .from(links)
      .where(eq(links.status, 'missing'))
      .get()
    const ruleRows = db
      .select({ name: rulesTable.name, dirTemplate: rulesTable.dirTemplate })
      .from(rulesTable)
      .where(eq(rulesTable.enabled, 1))
      .all()
    const roots = settingsStore.getSetting<string[]>('allowed_roots') ?? [
      ...DEFAULT_ROOTS,
    ]
    return {
      active_links: active?.c ?? 0,
      stale_links: stale?.c ?? 0,
      missing_links: missing?.c ?? 0,
      orphaned_rules: auditRuleRoots(ruleRows, roots),
    }
  })

  app.get('/api/apps/:appId', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const appId = Number((request.params as { appId: string }).appId)
    const row = db.select().from(apps).where(eq(apps.id, appId)).get()
    if (!row) throw new HttpError(404, 'app not found')
    return appOut(row)
  })

  app.post('/api/apps', (request, reply) => {
    getCurrentUser(request, db, settingsStore, env)
    const parsed = AppInSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    const body = parsed.data
    if (!body.api_key.trim())
      throw new HttpError(422, 'api_key is required to create an app')

    const res = db
      .insert(apps)
      .values({
        name: body.name,
        type: body.type,
        url: normalizeUrl(body.url),
        apiKey: body.api_key,
        enabled: body.enabled ? 1 : 0,
        pollIntervalS: body.poll_interval_s,
      })
      .run()
    const id = Number(res.lastInsertRowid)
    logEvent(db, 'info', `app added: ${body.name} (${body.type})`, id)
    reply.code(201)
    return appOut(db.select().from(apps).where(eq(apps.id, id)).get()!)
  })

  app.patch('/api/apps/:appId', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const appId = Number((request.params as { appId: string }).appId)
    const row = db.select().from(apps).where(eq(apps.id, appId)).get()
    if (!row) throw new HttpError(404, 'app not found')
    const parsed = AppInSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    const body = parsed.data

    // Changing type makes the poller treat this as a new app next rescan,
    // unlinking every existing hardlink after the grace period.
    if (body.type !== row.type) {
      const linked = db
        .select({ c: count() })
        .from(links)
        .where(and(eq(links.appId, appId), inArray(links.status, ['active', 'stale'])))
        .get()
      if ((linked?.c ?? 0) > 0) {
        throw new HttpError(
          422,
          `cannot change app type from ${row.type} to ${body.type}: this app has ` +
            'linked files, and switching type would unlink them. Delete the app ' +
            `(removes its links) and add it again as ${body.type}.`,
        )
      }
    }
    // blank api_key = keep the existing one (the UI can't recover the real key)
    const apiKey = body.api_key.trim() || row.apiKey
    db.update(apps)
      .set({
        name: body.name,
        type: body.type,
        url: normalizeUrl(body.url),
        apiKey,
        enabled: body.enabled ? 1 : 0,
        pollIntervalS: body.poll_interval_s,
      })
      .where(eq(apps.id, appId))
      .run()
    logEvent(db, 'info', `app updated: ${body.name}`, appId)
    return appOut(db.select().from(apps).where(eq(apps.id, appId)).get()!)
  })

  app.delete('/api/apps/:appId', (request, reply) => {
    getCurrentUser(request, db, settingsStore, env)
    const appId = Number((request.params as { appId: string }).appId)
    const existing = db.select({ id: apps.id }).from(apps).where(eq(apps.id, appId)).get()
    if (!existing) throw new HttpError(404, 'app not found')
    const roots = settingsStore.getSetting<string[]>('allowed_roots') ?? [
      ...DEFAULT_ROOTS,
    ]
    forceUnlinkAppLinks(db, appId, roots)
    db.delete(apps).where(eq(apps.id, appId)).run()
    logEvent(db, 'info', `app deleted: ${appId}`)
    reply.code(204).send()
  })

  app.post('/api/apps/test', async (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const parsed = AppInSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    const body = parsed.data
    const adapter = getAdapter(body.type, normalizeUrl(body.url), body.api_key)
    try {
      const info = await adapter.ping()
      return { ok: true, name: info.name, version: info.version }
    } catch (e) {
      if (e instanceof AdapterError) throw new HttpError(502, e.detail)
      throw e
    }
  })

  app.post('/api/apps/:appId/test', async (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const appId = Number((request.params as { appId: string }).appId)
    const row = db.select().from(apps).where(eq(apps.id, appId)).get()
    if (!row) throw new HttpError(404, 'app not found')
    const adapter = getAdapter(row.type, row.url, row.apiKey)
    try {
      const info = await adapter.ping()
      db.update(apps).set({ lastError: null }).where(eq(apps.id, appId)).run()
      logEvent(db, 'info', `connection test ok for ${row.name} (${info.version})`, appId)
      return { ok: true, name: info.name, version: info.version }
    } catch (e) {
      if (e instanceof AdapterError) {
        db.update(apps).set({ lastError: e.detail }).where(eq(apps.id, appId)).run()
        logEvent(db, 'warn', `connection test failed for ${row.name}: ${e.detail}`, appId)
        throw new HttpError(502, e.detail)
      }
      throw e
    }
  })

  app.post('/api/apps/:appId/rescan', async (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const appId = Number((request.params as { appId: string }).appId)
    const row = db.select({ name: apps.name }).from(apps).where(eq(apps.id, appId)).get()
    if (!row) throw new HttpError(404, 'app not found')
    const poller = getPoller()
    if (poller === null) throw new HttpError(503, 'poller not running')
    const result = await poller.rescan(appId)
    if (!result.ok) {
      const row2 = db
        .select({ lastError: apps.lastError })
        .from(apps)
        .where(eq(apps.id, appId))
        .get()
      throw new HttpError(502, row2?.lastError || 'poll failed')
    }
    return result
  })
}
