import { and, eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AdapterError } from '../arr/types.js'
import { getAdapter } from '../arr/factory.js'
import type { Settings } from '../config/env.js'
import type { DbClient } from '../db/client.js'
import { logEvent } from '../db/events.js'
import { apps, rules as rulesTable } from '../db/schema.js'
import type { SettingsStore } from '../db/settings-store.js'
import type { Condition } from '../core/matching.js'
import { parseRangeValue } from '../core/matching.js'
import { forceUnlinkRuleLinks } from '../core/linker.js'
import { planLinks, toPlannerItem, type PlannerRule } from '../core/planner.js'
import type { Poller } from '../core/poller.js'
import { snapshotItems } from '../core/snapshot.js'
import {
  DEFAULT_ROOTS,
  FIXED_PLACEHOLDERS,
  TemplateError,
  checkJail,
  findPlaceholders,
  staticPrefix,
} from '../core/template.js'
import {
  NUMERIC_CATEGORIES,
  RICH_CATEGORIES,
  expandVocabularyConditions,
  validateConditionValues,
} from '../core/vocabulary.js'
import { HttpError } from '../http-error.js'
import { getCurrentUser } from './auth.js'

/** Rules CRUD, validation, and preview. Ported from api/rules.py. Wire format
 * is snake_case throughout, matching web/ and the Python backend; internally
 * (DB storage, the matching/planner engine) stays camelCase -- see
 * conditionToInternal/conditionToWire below for the boundary. */

export interface RulesRouteOptions {
  db: DbClient
  settingsStore: SettingsStore
  env: Settings
  getPoller: () => Poller | null
}

type RuleRow = typeof rulesTable.$inferSelect

const ConditionInSchema = z
  .object({
    category: z.enum([
      'user',
      'title',
      'genre',
      'language',
      'audio_language',
      'quality',
      'certification',
      'collection',
      'studio',
      'network',
      'series_type',
      'video_codec',
      'video_dynamic_range',
      'audio_codec',
      'audio_channels',
      'rating',
      'popularity',
      'runtime',
      'custom',
    ]),
    match_type: z.enum(['exact', 'list', 'regex', 'vocabulary', 'range']),
    // "vocabulary" intentionally carries an empty match_value
    match_value: z.string().max(2000),
    join: z.enum(['AND', 'OR']).nullable().default(null),
    // null/absent = "tag"; "native" matches real Radarr/Sonarr metadata, rich/numeric categories only.
    source: z.enum(['tag', 'native']).nullable().default(null),
  })
  .superRefine((c, ctx) => {
    if (c.source === 'native' && !RICH_CATEGORIES.has(c.category) && !NUMERIC_CATEGORIES.has(c.category)) {
      ctx.addIssue({
        code: 'custom',
        message:
          `condition '${c.category}': native-metadata matching is only available ` +
          'for title/genre/language/audio_language/quality/certification/collection/' +
          'studio/network/series_type/video_codec/video_dynamic_range/audio_codec/audio_channels/' +
          'rating/popularity/runtime',
      })
    }
    if (c.match_type === 'range') {
      if (parseRangeValue(c.match_value) === null) {
        ctx.addIssue({
          code: 'custom',
          message:
            `condition '${c.category}': range requires JSON like {"min":7} or ` +
            '{"min":null,"max":90} -- at least one of min/max must be a number',
        })
      }
    } else if (c.match_type === 'regex') {
      try {
        new RegExp(c.match_value)
      } catch (e) {
        ctx.addIssue({
          code: 'custom',
          message: `condition '${c.category}': invalid regex: ${String(e)}`,
        })
      }
    } else if (c.match_type === 'list') {
      if (
        c.match_value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean).length === 0
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `condition '${c.category}': list requires at least one comma-separated tag`,
        })
      }
    } else if (c.match_type === 'exact') {
      if (!c.match_value.trim()) {
        ctx.addIssue({
          code: 'custom',
          message: `condition '${c.category}': exact match requires a value`,
        })
      }
    }
  })

type ConditionIn = z.infer<typeof ConditionInSchema>

function conditionToInternal(c: ConditionIn): Condition {
  return {
    category: c.category,
    matchType: c.match_type,
    matchValue: c.match_value,
    join: c.join,
    source: c.source,
  }
}

function conditionToWire(c: Condition): Record<string, unknown> {
  return {
    category: c.category,
    match_type: c.matchType,
    match_value: c.matchValue,
    join: c.join,
    source: c.source ?? null,
  }
}

const RuleInSchema = z
  .object({
    name: z.string().min(1).max(50),
    app_scope: z.number().int().nullable().default(null),
    app_type_scope: z.enum(['radarr', 'sonarr']).nullable().default(null),
    conditions: z.array(ConditionInSchema).min(1).max(8),
    dir_template: z.string().min(1).max(300),
    filename_template: z.string().max(300).nullable().default(null),
    // "source" (default): the item's own source folder name is always
    // appended under dir_template automatically. "custom": that append is
    // skipped, and dir_template alone must resolve the full destination
    // folder name (the pre-9b72b2d behavior).
    dir_naming_mode: z.enum(['source', 'custom']).default('source'),
    enabled: z.boolean().default(true),
    unlink_on_mismatch: z.boolean().default(true),
    priority: z.number().int().min(1).max(1000).default(100),
  })
  .superRefine((body, ctx) => {
    if (body.app_scope !== null && body.app_type_scope !== null) {
      ctx.addIssue({
        code: 'custom',
        message:
          'app_scope and app_type_scope are mutually exclusive -- pick a specific ' +
          'service or an entire service type, not both',
      })
    }
    const seen = new Set<string>()
    body.conditions.forEach((c, i) => {
      if (seen.has(c.category)) {
        ctx.addIssue({
          code: 'custom',
          message:
            `duplicate condition category '${c.category}': at most one condition ` +
            'per category is allowed in a rule',
        })
      }
      seen.add(c.category)
      if (i === 0 && c.join !== null) {
        ctx.addIssue({
          code: 'custom',
          message: 'the first condition must not have a join operator',
        })
      }
      if (i > 0 && c.join === null) {
        ctx.addIssue({
          code: 'custom',
          message: `condition ${i + 1} requires a join operator (AND/OR)`,
        })
      }
    })
    if (body.dir_template.includes('\\')) {
      ctx.addIssue({
        code: 'custom',
        message: 'dir_template must not contain backslashes',
      })
    }
    if (!body.dir_template.startsWith('/')) {
      ctx.addIssue({
        code: 'custom',
        message: 'dir_template must be an absolute path (e.g. /media/movies/{$user})',
      })
    }
    if (body.filename_template !== null && body.filename_template.includes('\\')) {
      ctx.addIssue({
        code: 'custom',
        message: 'filename_template must not contain backslashes',
      })
    }
    // Catch a placeholder typo here rather than have it fail later, per-item, at match time.
    const known = new Set([...FIXED_PLACEHOLDERS, ...seen])
    for (const [field, tmpl] of [
      ['dir_template', body.dir_template],
      ['filename_template', body.filename_template],
    ] as const) {
      if (tmpl === null) continue
      for (const name of findPlaceholders(tmpl)) {
        if (!known.has(name)) {
          ctx.addIssue({
            code: 'custom',
            message: `${field}: unknown placeholder {$${name}} -- must be one of ${[...known].sort().join(', ')}`,
          })
        }
      }
    }
  })

type RuleIn = z.infer<typeof RuleInSchema>

function parseBody(body: unknown): RuleIn {
  const parsed = RuleInSchema.safeParse(body)
  if (!parsed.success) {
    throw new HttpError(
      422,
      parsed.error.issues.map((i) => i.message).join('; ') || 'invalid request body',
    )
  }
  return parsed.data
}

/** The app_type to check/expand a rule's conditions against, or null if unscoped. */
function resolveAppType(
  db: DbClient,
  appScope: number | null,
  appTypeScope: string | null,
): string | null {
  if (appTypeScope !== null) return appTypeScope
  if (appScope !== null) {
    const row = db
      .select({ type: apps.type })
      .from(apps)
      .where(eq(apps.id, appScope))
      .get()
    return row?.type ?? null
  }
  return null
}

function vocabularyWarnings(db: DbClient, body: RuleIn): string[] {
  const appType = resolveAppType(db, body.app_scope, body.app_type_scope)
  // Every enabled instance in scope, not just one representative -- so a
  // type-scoped rule's warnings (and the value picker behind
  // GET /api/vocabulary) see the union of each instance's own vocabulary
  // instead of going silently empty just because there's no single app_id.
  const appIds = scopeAppIds(db, body.app_scope, body.app_type_scope)
  const warnings: string[] = []
  for (const c of body.conditions) {
    warnings.push(...validateConditionValues(conditionToInternal(c), db, appType, appIds))
  }
  return warnings
}

function ruleOut(
  row: RuleRow,
  linkCount = 0,
  lastLinkAt: number | null = null,
): Record<string, unknown> {
  let conditions: Condition[]
  try {
    conditions = JSON.parse(row.conditionsJson) as Condition[]
  } catch {
    conditions = []
  }
  return {
    id: row.id,
    name: row.name,
    app_scope: row.appScope,
    app_type_scope: row.appTypeScope,
    dir_template: row.dirTemplate,
    filename_template: row.filenameTemplate,
    dir_naming_mode: row.dirNamingMode,
    enabled: Boolean(row.enabled),
    unlink_on_mismatch: Boolean(row.unlinkOnMismatch),
    priority: row.priority,
    created_at: row.createdAt,
    conditions: conditions.map(conditionToWire),
    link_count: linkCount,
    last_link_at: lastLinkAt,
  }
}

/** Enabled app ids a rule with this scope covers -- the same set the poller
 * itself would match via ruleAppliesToApp(). Exported for presets.ts, whose
 * preset-apply endpoint creates a rule the same way POST /api/rules does. */
export function scopeAppIds(
  db: DbClient,
  appScope: number | null,
  appTypeScope: string | null,
): number[] {
  if (appScope !== null) {
    const row = db
      .select({ id: apps.id })
      .from(apps)
      .where(and(eq(apps.id, appScope), eq(apps.enabled, 1)))
      .get()
    return row ? [row.id] : []
  }
  const rows =
    appTypeScope !== null
      ? db
          .select({ id: apps.id })
          .from(apps)
          .where(and(eq(apps.type, appTypeScope), eq(apps.enabled, 1)))
          .all()
      : db.select({ id: apps.id }).from(apps).where(eq(apps.enabled, 1)).all()
  return rows.map((r) => r.id)
}

/** Saving/deleting a rule should apply immediately rather than silently
 * waiting for the next scheduled poll (or a user separately finding the
 * Rescan button) -- but a rescan is a real network round-trip per app, so it
 * must not block the response or fail the save over an unrelated adapter
 * error. Runs sequentially, not Promise.all, so an unscoped rule across many
 * configured apps doesn't fire a rescan burst all at once. */
export function triggerRescan(poller: Poller | null, appIds: number[]): void {
  if (poller === null || appIds.length === 0) return
  const unique = [...new Set(appIds)]
  // pollOnce() already logs a warn event with the failure detail -- nothing
  // further to do with the result here.
  void (async () => {
    for (const id of unique) await poller.rescan(id)
  })()
}

function checkDirTemplateJail(settingsStore: SettingsStore, dirTemplate: string): void {
  const roots = settingsStore.getSetting<string[]>('allowed_roots') ?? [...DEFAULT_ROOTS]
  try {
    checkJail(staticPrefix(dirTemplate), roots)
  } catch (e) {
    if (e instanceof TemplateError) throw new HttpError(422, e.message)
    throw e
  }
}

export function registerRulesRoutes(app: FastifyInstance, opts: RulesRouteOptions): void {
  const { db, settingsStore, env, getPoller } = opts

  app.get('/api/rules', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const rows = db
      .select({
        rule: rulesTable,
        linkCount: sql<number>`(SELECT COUNT(*) FROM links l WHERE l.rule_id = ${rulesTable.id})`,
        lastLinkAt: sql<
          number | null
        >`(SELECT MAX(created_at) FROM links l WHERE l.rule_id = ${rulesTable.id})`,
      })
      .from(rulesTable)
      .orderBy(rulesTable.priority, rulesTable.id)
      .all()
    return rows.map((r) => ruleOut(r.rule, r.linkCount, r.lastLinkAt))
  })

  app.get('/api/rules/:ruleId', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const ruleId = Number((request.params as { ruleId: string }).ruleId)
    const row = db.select().from(rulesTable).where(eq(rulesTable.id, ruleId)).get()
    if (!row) throw new HttpError(404, 'rule not found')
    return ruleOut(row)
  })

  app.post('/api/rules', (request, reply) => {
    getCurrentUser(request, db, settingsStore, env)
    const body = parseBody(request.body)
    if (
      body.app_scope !== null &&
      !db.select({ id: apps.id }).from(apps).where(eq(apps.id, body.app_scope)).get()
    ) {
      throw new HttpError(422, 'app_scope references unknown app')
    }
    checkDirTemplateJail(settingsStore, body.dir_template)
    const res = db
      .insert(rulesTable)
      .values({
        name: body.name,
        appScope: body.app_scope,
        appTypeScope: body.app_type_scope,
        conditionsJson: JSON.stringify(body.conditions.map(conditionToInternal)),
        dirTemplate: body.dir_template,
        filenameTemplate: body.filename_template,
        dirNamingMode: body.dir_naming_mode,
        enabled: body.enabled ? 1 : 0,
        unlinkOnMismatch: body.unlink_on_mismatch ? 1 : 0,
        priority: body.priority,
      })
      .run()
    const id = Number(res.lastInsertRowid)
    logEvent(db, 'info', `rule added: ${body.name}`, null, id)
    const out = ruleOut(db.select().from(rulesTable).where(eq(rulesTable.id, id)).get()!)
    triggerRescan(getPoller(), scopeAppIds(db, body.app_scope, body.app_type_scope))
    reply.code(201)
    return { ...out, vocabulary_warnings: vocabularyWarnings(db, body) }
  })

  app.patch('/api/rules/:ruleId', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const ruleId = Number((request.params as { ruleId: string }).ruleId)
    const existing = db
      .select({ appScope: rulesTable.appScope, appTypeScope: rulesTable.appTypeScope })
      .from(rulesTable)
      .where(eq(rulesTable.id, ruleId))
      .get()
    if (!existing) throw new HttpError(404, 'rule not found')
    const body = parseBody(request.body)
    if (
      body.app_scope !== null &&
      !db.select({ id: apps.id }).from(apps).where(eq(apps.id, body.app_scope)).get()
    ) {
      throw new HttpError(422, 'app_scope references unknown app')
    }
    checkDirTemplateJail(settingsStore, body.dir_template)
    db.update(rulesTable)
      .set({
        name: body.name,
        appScope: body.app_scope,
        appTypeScope: body.app_type_scope,
        conditionsJson: JSON.stringify(body.conditions.map(conditionToInternal)),
        dirTemplate: body.dir_template,
        filenameTemplate: body.filename_template,
        dirNamingMode: body.dir_naming_mode,
        enabled: body.enabled ? 1 : 0,
        unlinkOnMismatch: body.unlink_on_mismatch ? 1 : 0,
        priority: body.priority,
      })
      .where(eq(rulesTable.id, ruleId))
      .run()
    const out = ruleOut(
      db.select().from(rulesTable).where(eq(rulesTable.id, ruleId)).get()!,
    )
    // Rescan the new scope, plus the old scope if it narrowed/moved -- e.g. a
    // rule that used to apply to all apps and now only applies to one still
    // needs the other apps rescanned so their now-stale links retire promptly.
    triggerRescan(getPoller(), [
      ...scopeAppIds(db, body.app_scope, body.app_type_scope),
      ...scopeAppIds(db, existing.appScope, existing.appTypeScope),
    ])
    return { ...out, vocabulary_warnings: vocabularyWarnings(db, body) }
  })

  app.delete('/api/rules/:ruleId', (request, reply) => {
    getCurrentUser(request, db, settingsStore, env)
    const ruleId = Number((request.params as { ruleId: string }).ruleId)
    const existing = db
      .select({ appScope: rulesTable.appScope, appTypeScope: rulesTable.appTypeScope })
      .from(rulesTable)
      .where(eq(rulesTable.id, ruleId))
      .get()
    if (!existing) throw new HttpError(404, 'rule not found')
    const roots = settingsStore.getSetting<string[]>('allowed_roots') ?? [
      ...DEFAULT_ROOTS,
    ]
    forceUnlinkRuleLinks(db, ruleId, roots)
    db.delete(rulesTable).where(eq(rulesTable.id, ruleId)).run()
    logEvent(db, 'info', `rule deleted: ${ruleId}`)
    // So the deleted rule's links retire promptly instead of waiting for the
    // next natural poll.
    triggerRescan(getPoller(), scopeAppIds(db, existing.appScope, existing.appTypeScope))
    reply.code(204).send()
  })

  // Dry-run for live warnings in the rule editor -- no persistence.
  app.post('/api/rules/vocabulary-check', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const body = parseBody(request.body)
    return { warnings: vocabularyWarnings(db, body) }
  })

  app.post('/api/rules/preview', async (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const body = parseBody(request.body)
    const query = request.query as { app_id?: string; live?: string }
    const appId = Number(query.app_id)
    const live = query.live === 'true' || query.live === '1'
    if (!Number.isFinite(appId)) throw new HttpError(422, 'app_id is required')

    const row = db.select().from(apps).where(eq(apps.id, appId)).get()
    if (!row) throw new HttpError(404, 'app not found')

    let source: 'snapshot' | 'live' = 'snapshot'
    let items = live ? [] : snapshotItems(db, appId)
    if (items.length === 0) {
      source = 'live'
      const adapter = getAdapter(row.type, row.url, row.apiKey)
      try {
        items = await adapter.fetchItems()
      } catch (e) {
        const detail = e instanceof AdapterError ? e.detail : String(e)
        throw new HttpError(502, detail)
      }
    }

    const rule: PlannerRule = {
      id: 0,
      name: body.name || '(preview)',
      conditions: body.conditions.map(conditionToInternal),
      dirTemplate: body.dir_template,
      filenameTemplate: body.filename_template,
      dirNamingMode: body.dir_naming_mode,
      enabled: true,
      priority: body.priority,
      appScope: body.app_scope,
      appTypeScope: body.app_type_scope,
    }
    const roots = settingsStore.getSetting<string[]>('allowed_roots') ?? [
      ...DEFAULT_ROOTS,
    ]
    const rules = expandVocabularyConditions([rule], db, appId, row.type)
    const { planned, errors } = planLinks(
      rules,
      items.map((it) => toPlannerItem(it, it.id)),
      row.name,
      appId,
      roots,
      row.type,
    )

    return {
      app_id: appId,
      app_name: row.name,
      source,
      snapshot_at: source === 'snapshot' ? row.lastPollAt : null,
      total: planned.length,
      sample: planned.slice(0, 50).map((p) => ({
        item_title: p.itemTitle,
        src_path: p.srcPath,
        dst_path: p.dstPath,
      })),
      errors: errors.slice(0, 50).map((e) => ({
        item_title: e.itemTitle,
        src_path: e.srcPath,
        error: e.error,
      })),
    }
  })
}
