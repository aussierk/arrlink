import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AdapterError } from '../arr/types.js'
import { getAdapter } from '../arr/factory.js'
import type { Settings } from '../config/env.js'
import type { DbClient } from '../db/client.js'
import { logEvent } from '../db/events.js'
import { apps, rules as rulesTable } from '../db/schema.js'
import type { SettingsStore } from '../db/settings-store.js'
import { planLinks, type PlannerRule } from '../core/planner.js'
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
  RICH_CATEGORIES,
  expandVocabularyConditions,
  validateConditionValues,
} from '../core/vocabulary.js'
import { HttpError } from '../http-error.js'
import { getCurrentUser } from './auth.js'

/** Rules CRUD: storage, validation, matching, templates, and preview. Ported
 * from api/rules.py. */

export interface RulesRouteOptions {
  db: DbClient
  settingsStore: SettingsStore
  env: Settings
}

type RuleRow = typeof rulesTable.$inferSelect

const ConditionInSchema = z
  .object({
    category: z.enum([
      'user',
      'genre',
      'language',
      'quality',
      'certification',
      'collection',
      'custom',
    ]),
    matchType: z.enum(['exact', 'list', 'regex', 'vocabulary']),
    // min length relaxed to 0: "vocabulary" intentionally carries an empty match_value
    matchValue: z.string().max(2000),
    join: z.enum(['AND', 'OR']).nullable().default(null),
    // null/absent == "tag". "native" matches the item's real Radarr/Sonarr
    // metadata instead of its arbitrary tags; only offered for rich categories.
    source: z.enum(['tag', 'native']).nullable().default(null),
  })
  .superRefine((c, ctx) => {
    if (c.source === 'native' && !RICH_CATEGORIES.has(c.category)) {
      ctx.addIssue({
        code: 'custom',
        message:
          `condition '${c.category}': native-metadata matching is only available ` +
          'for genre/language/quality/certification/collection',
      })
    }
    if (c.matchType === 'regex') {
      try {
        new RegExp(c.matchValue)
      } catch (e) {
        ctx.addIssue({
          code: 'custom',
          message: `condition '${c.category}': invalid regex: ${String(e)}`,
        })
      }
    } else if (c.matchType === 'list') {
      if (
        c.matchValue
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean).length === 0
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `condition '${c.category}': list requires at least one comma-separated tag`,
        })
      }
    } else if (c.matchType === 'exact') {
      if (!c.matchValue.trim()) {
        ctx.addIssue({
          code: 'custom',
          message: `condition '${c.category}': exact match requires a value`,
        })
      }
    }
  })

const RuleInSchema = z
  .object({
    name: z.string().min(1).max(50),
    appScope: z.number().int().nullable().default(null),
    appTypeScope: z.enum(['radarr', 'sonarr']).nullable().default(null),
    conditions: z.array(ConditionInSchema).min(1).max(8),
    dirTemplate: z.string().min(1).max(300),
    filenameTemplate: z.string().max(300).nullable().default(null),
    enabled: z.boolean().default(true),
    unlinkOnMismatch: z.boolean().default(true),
    priority: z.number().int().min(1).max(1000).default(100),
  })
  .superRefine((body, ctx) => {
    if (body.appScope !== null && body.appTypeScope !== null) {
      ctx.addIssue({
        code: 'custom',
        message:
          'app_scope and app_type_scope are mutually exclusive — pick a specific ' +
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
    if (body.dirTemplate.includes('\\')) {
      ctx.addIssue({
        code: 'custom',
        message: 'dir_template must not contain backslashes',
      })
    }
    if (!body.dirTemplate.startsWith('/')) {
      ctx.addIssue({
        code: 'custom',
        message: 'dir_template must be an absolute path (e.g. /media/movies/{$user})',
      })
    }
    if (body.filenameTemplate !== null && body.filenameTemplate.includes('\\')) {
      ctx.addIssue({
        code: 'custom',
        message: 'filename_template must not contain backslashes',
      })
    }
    // A placeholder is only ever resolvable if it's a fixed name or a
    // category this rule actually has a condition for -- catch a typo here
    // rather than have it silently fail later, per-item, at match time.
    const known = new Set([...FIXED_PLACEHOLDERS, ...seen])
    for (const [field, tmpl] of [
      ['dir_template', body.dirTemplate],
      ['filename_template', body.filenameTemplate],
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

/** The app_type a rule's conditions should be checked/expanded against, or
 * null if the rule is unscoped -- vocabulary validation/expansion no-ops then. */
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

/** One concrete app id to check instance-scoped vocabulary against, when the
 * rule isn't pinned to a specific app. */
function representativeAppId(
  db: DbClient,
  appScope: number | null,
  appTypeScope: string | null,
): number | null {
  if (appScope !== null) return appScope
  if (appTypeScope !== null) {
    const row = db
      .select({ id: apps.id })
      .from(apps)
      .where(sql`${apps.type} = ${appTypeScope} AND ${apps.enabled} = 1`)
      .orderBy(apps.id)
      .limit(1)
      .get()
    return row?.id ?? null
  }
  return null
}

function vocabularyWarnings(db: DbClient, body: RuleIn): string[] {
  const appType = resolveAppType(db, body.appScope, body.appTypeScope)
  const appId = representativeAppId(db, body.appScope, body.appTypeScope)
  const warnings: string[] = []
  for (const c of body.conditions) {
    warnings.push(...validateConditionValues(c, db, appType, appId))
  }
  return warnings
}

function ruleOut(
  row: RuleRow,
  linkCount = 0,
  lastLinkAt: number | null = null,
): Record<string, unknown> {
  let conditions: unknown[]
  try {
    conditions = JSON.parse(row.conditionsJson) as unknown[]
  } catch {
    conditions = []
  }
  const { conditionsJson: _omit, ...rest } = row
  return {
    ...rest,
    enabled: Boolean(row.enabled),
    unlinkOnMismatch: Boolean(row.unlinkOnMismatch),
    conditions,
    linkCount,
    lastLinkAt,
  }
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
  const { db, settingsStore, env } = opts

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
      body.appScope !== null &&
      !db.select({ id: apps.id }).from(apps).where(eq(apps.id, body.appScope)).get()
    ) {
      throw new HttpError(422, 'app_scope references unknown app')
    }
    checkDirTemplateJail(settingsStore, body.dirTemplate)
    const res = db
      .insert(rulesTable)
      .values({
        name: body.name,
        appScope: body.appScope,
        appTypeScope: body.appTypeScope,
        conditionsJson: JSON.stringify(body.conditions),
        dirTemplate: body.dirTemplate,
        filenameTemplate: body.filenameTemplate,
        enabled: body.enabled ? 1 : 0,
        unlinkOnMismatch: body.unlinkOnMismatch ? 1 : 0,
        priority: body.priority,
      })
      .run()
    const id = Number(res.lastInsertRowid)
    logEvent(db, 'info', `rule added: ${body.name}`, null, id)
    const out = ruleOut(db.select().from(rulesTable).where(eq(rulesTable.id, id)).get()!)
    reply.code(201)
    return { ...out, vocabularyWarnings: vocabularyWarnings(db, body) }
  })

  app.patch('/api/rules/:ruleId', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const ruleId = Number((request.params as { ruleId: string }).ruleId)
    if (
      !db
        .select({ id: rulesTable.id })
        .from(rulesTable)
        .where(eq(rulesTable.id, ruleId))
        .get()
    ) {
      throw new HttpError(404, 'rule not found')
    }
    const body = parseBody(request.body)
    if (
      body.appScope !== null &&
      !db.select({ id: apps.id }).from(apps).where(eq(apps.id, body.appScope)).get()
    ) {
      throw new HttpError(422, 'app_scope references unknown app')
    }
    checkDirTemplateJail(settingsStore, body.dirTemplate)
    db.update(rulesTable)
      .set({
        name: body.name,
        appScope: body.appScope,
        appTypeScope: body.appTypeScope,
        conditionsJson: JSON.stringify(body.conditions),
        dirTemplate: body.dirTemplate,
        filenameTemplate: body.filenameTemplate,
        enabled: body.enabled ? 1 : 0,
        unlinkOnMismatch: body.unlinkOnMismatch ? 1 : 0,
        priority: body.priority,
      })
      .where(eq(rulesTable.id, ruleId))
      .run()
    const out = ruleOut(
      db.select().from(rulesTable).where(eq(rulesTable.id, ruleId)).get()!,
    )
    return { ...out, vocabularyWarnings: vocabularyWarnings(db, body) }
  })

  app.delete('/api/rules/:ruleId', (request, reply) => {
    getCurrentUser(request, db, settingsStore, env)
    const ruleId = Number((request.params as { ruleId: string }).ruleId)
    const res = db.delete(rulesTable).where(eq(rulesTable.id, ruleId)).run()
    if (res.changes === 0) throw new HttpError(404, 'rule not found')
    logEvent(db, 'info', `rule deleted: ${ruleId}`)
    reply.code(204).send()
  })

  // Dry-run vocabulary-membership validation with no persistence, so the
  // rule editor can show warnings live while the user is still typing.
  app.post('/api/rules/vocabulary-check', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const body = parseBody(request.body)
    return { warnings: vocabularyWarnings(db, body) }
  })

  app.post('/api/rules/preview', async (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const body = parseBody(request.body)
    const query = request.query as { appId?: string; live?: string }
    const appId = Number(query.appId)
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
      conditions: body.conditions,
      dirTemplate: body.dirTemplate,
      filenameTemplate: body.filenameTemplate,
      enabled: true,
      priority: body.priority,
      appScope: body.appScope,
      appTypeScope: body.appTypeScope,
    }
    const roots = settingsStore.getSetting<string[]>('allowed_roots') ?? [
      ...DEFAULT_ROOTS,
    ]
    const rules = expandVocabularyConditions([rule], db, appId, row.type)
    const { planned, errors } = planLinks(
      rules,
      items.map((it) => ({
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
      })),
      row.name,
      appId,
      roots,
      row.type,
    )

    return {
      appId,
      appName: row.name,
      source,
      snapshotAt: source === 'snapshot' ? row.lastPollAt : null,
      total: planned.length,
      sample: planned.slice(0, 50).map((p) => ({
        itemTitle: p.itemTitle,
        srcPath: p.srcPath,
        dstPath: p.dstPath,
      })),
      errors: errors.slice(0, 50).map((e) => ({
        itemTitle: e.itemTitle,
        srcPath: e.srcPath,
        error: e.error,
      })),
    }
  })
}
