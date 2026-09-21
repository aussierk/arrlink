import { dirname } from 'node:path'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { Settings } from '../config/env.js'
import type { DbClient } from '../db/client.js'
import { logEvent } from '../db/events.js'
import { apps, links, rules as rulesTable } from '../db/schema.js'
import type { SettingsStore } from '../db/settings-store.js'
import {
  createLink,
  ensureDir,
  inodeOf,
  removeLink,
  resolveFsFallback,
} from '../core/fsutil.js'
import { normalizeFsFallback } from '../config/env.js'
import { HttpError } from '../http-error.js'
import { getCurrentUser } from './auth.js'

/** Browse/delete/repair hardlinks. Ported from api/links.py. Wire format is
 * snake_case, matching web/ and the Python backend. */

export interface LinksRouteOptions {
  db: DbClient
  settingsStore: SettingsStore
  env: Settings
}

type LinkRow = typeof links.$inferSelect

function linkOut(
  row: LinkRow,
  ruleName: string | null,
  appName: string | null,
  appType: string | null,
): Record<string, unknown> {
  return {
    id: row.id,
    rule_id: row.ruleId,
    app_id: row.appId,
    item_id: row.itemId,
    file_id: row.fileId,
    src_path: row.srcPath,
    dst_path: row.dstPath,
    inode: row.inode,
    status: row.status,
    created_at: row.createdAt,
    match_key: row.matchKey,
    missing_strikes: row.missingStrikes,
    rule_name: ruleName,
    app_name: appName,
    app_type: appType,
  }
}

export function registerLinksRoutes(app: FastifyInstance, opts: LinksRouteOptions): void {
  const { db, settingsStore, env } = opts

  app.get('/api/links', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const q = request.query as {
      app_id?: string
      rule_id?: string
      status?: string
      limit?: string
      offset?: string
    }
    const appId = q.app_id !== undefined ? Number(q.app_id) : undefined
    const ruleId = q.rule_id !== undefined ? Number(q.rule_id) : undefined
    const status = q.status !== undefined ? q.status : 'active'
    const limit = Math.min(
      5000,
      Math.max(1, q.limit !== undefined ? Number(q.limit) : 500),
    )
    const offset = Math.max(0, q.offset !== undefined ? Number(q.offset) : 0)

    const conditions = []
    if (appId !== undefined) conditions.push(eq(links.appId, appId))
    if (ruleId !== undefined) conditions.push(eq(links.ruleId, ruleId))
    if (status) conditions.push(eq(links.status, status))
    const where = conditions.length > 0 ? and(...conditions) : undefined

    const totalRow = db
      .select({ c: sql<number>`COUNT(*)` })
      .from(links)
      .where(where)
      .get()
    const total = totalRow?.c ?? 0

    const rows = db
      .select({
        link: links,
        ruleName: rulesTable.name,
        appName: apps.name,
        appType: apps.type,
      })
      .from(links)
      .leftJoin(rulesTable, eq(rulesTable.id, links.ruleId))
      .leftJoin(apps, eq(apps.id, links.appId))
      .where(where)
      .orderBy(desc(links.id))
      .limit(limit)
      .offset(offset)
      .all()

    return {
      items: rows.map((r) => linkOut(r.link, r.ruleName, r.appName, r.appType)),
      total,
      limit,
      offset,
    }
  })

  app.delete('/api/links/:linkId', (request, reply) => {
    getCurrentUser(request, db, settingsStore, env)
    const linkId = Number((request.params as { linkId: string }).linkId)
    const row = db.select().from(links).where(eq(links.id, linkId)).get()
    if (!row) throw new HttpError(404, 'link not found')
    const r = removeLink(row.dstPath)
    if (!r.ok && r.error) throw new HttpError(500, r.error)
    db.update(links).set({ status: 'missing' }).where(eq(links.id, linkId)).run()
    logEvent(db, 'info', `link removed: ${row.dstPath}`)
    reply.code(204).send()
  })

  // Re-create active links whose dst disappeared but whose source survives.
  app.post('/api/links/repair', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    let fixed = 0
    let failed = 0
    const fallback = resolveFsFallback(settingsStore, normalizeFsFallback(env.fsFallback))
    // 'missing' too: source may have (re)appeared since removal.
    const rows = db
      .select({ id: links.id, dstPath: links.dstPath, srcPath: links.srcPath })
      .from(links)
      .where(inArray(links.status, ['active', 'stale', 'missing']))
      .all()
    for (const row of rows) {
      if (inodeOf(row.dstPath) !== null) continue
      if (inodeOf(row.srcPath) === null) continue
      ensureDir(dirname(row.dstPath))
      const r = createLink(row.srcPath, row.dstPath, fallback)
      if (r.ok) {
        fixed += 1
        db.update(links)
          .set({ status: 'active', inode: inodeOf(row.dstPath), missingStrikes: 0 })
          .where(eq(links.id, row.id))
          .run()
      } else {
        failed += 1
      }
    }
    if (fixed) logEvent(db, 'info', `repair: re-created ${fixed} link(s)`)
    return { fixed, failed }
  })
}
