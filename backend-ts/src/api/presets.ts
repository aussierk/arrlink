import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Settings } from '../config/env.js'
import type { DbClient } from '../db/client.js'
import { logEvent } from '../db/events.js'
import { apps, rules as rulesTable } from '../db/schema.js'
import type { SettingsStore } from '../db/settings-store.js'
import {
  defaultBaseFolder,
  getPreset,
  listPresetsForType,
  renderPreset,
  type RenderedPreset,
} from '../core/presets.js'
import type { Condition } from '../core/matching.js'
import { DEFAULT_ROOTS, TemplateError, checkJail } from '../core/template.js'
import { HttpError } from '../http-error.js'
import { getCurrentUser } from './auth.js'

/** List preset rules per app type + apply one as an editable rule. Ported
 * from api/presets.py. Wire format is snake_case; core/presets.ts stays
 * camelCase internally. */

export interface PresetsRouteOptions {
  db: DbClient
  settingsStore: SettingsStore
  env: Settings
}

const APP_TYPES = new Set(['radarr', 'sonarr'])

type RuleRow = typeof rulesTable.$inferSelect

const PresetApplySchema = z.object({
  preset_key: z.string().min(1).max(50),
  app_scope: z.number().int().nullable().default(null),
  app_type: z.string().min(1).max(20),
  base_folder: z.string().min(1).max(300).nullable().default(null),
  name: z.string().min(1).max(50).nullable().default(null),
})

function presetOut(p: RenderedPreset): Record<string, unknown> {
  return {
    key: p.key,
    name: p.name,
    description: p.description,
    category: p.category,
    match_type: p.matchType,
    match_value: p.matchValue,
    subpath: p.subpath,
    default_base_folder: p.defaultBaseFolder,
    base_folder: p.baseFolder,
    dir_template: p.dirTemplate,
  }
}

function ruleOut(row: RuleRow): Record<string, unknown> {
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
    enabled: Boolean(row.enabled),
    unlink_on_mismatch: Boolean(row.unlinkOnMismatch),
    priority: row.priority,
    created_at: row.createdAt,
    conditions: conditions.map((c) => ({
      category: c.category,
      match_type: c.matchType,
      match_value: c.matchValue,
      join: c.join,
      source: c.source ?? null,
    })),
  }
}

export function registerPresetsRoutes(
  app: FastifyInstance,
  opts: PresetsRouteOptions,
): void {
  const { db, settingsStore, env } = opts

  app.get('/api/presets', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const q = request.query as { app_type?: string; base_folder?: string }
    const appType = q.app_type ?? ''
    if (!APP_TYPES.has(appType)) {
      throw new HttpError(422, `app_type must be one of ${[...APP_TYPES].join(', ')}`)
    }
    return {
      app_type: appType,
      base_folder: q.base_folder || defaultBaseFolder(appType),
      presets: listPresetsForType(appType, q.base_folder).map(presetOut),
    }
  })

  app.post('/api/presets/apply', (request, reply) => {
    getCurrentUser(request, db, settingsStore, env)
    const parsed = PresetApplySchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    const body = parsed.data

    const preset = getPreset(body.preset_key)
    if (!preset) throw new HttpError(422, `unknown preset: ${body.preset_key}`)
    if (!APP_TYPES.has(body.app_type)) {
      throw new HttpError(422, `app_type must be one of ${[...APP_TYPES].join(', ')}`)
    }
    if (
      body.app_scope !== null &&
      !db.select({ id: apps.id }).from(apps).where(eq(apps.id, body.app_scope)).get()
    ) {
      throw new HttpError(422, 'app_scope references unknown app')
    }

    const base = (body.base_folder || defaultBaseFolder(body.app_type)).trim()
    if (base.includes('\\') || !base.startsWith('/')) {
      throw new HttpError(422, 'base_folder must be an absolute path')
    }

    const rendered = renderPreset(body.preset_key, body.app_type, base)!
    // Base folder must stay under an allowed root; preset subpaths are
    // placeholder-only, so this jails the whole resolved tree.
    const roots = settingsStore.getSetting<string[]>('allowed_roots') ?? [
      ...DEFAULT_ROOTS,
    ]
    try {
      checkJail(base, roots)
    } catch (e) {
      if (e instanceof TemplateError) throw new HttpError(422, e.message)
      throw e
    }

    const [matchType, matchValue] = preset.matchers[body.app_type]
    const name = body.name || `preset:${preset.key}`
    const conditionsJson = JSON.stringify([
      { category: preset.category, matchType, matchValue, join: null },
    ])
    const res = db
      .insert(rulesTable)
      .values({
        name,
        appScope: body.app_scope,
        conditionsJson,
        dirTemplate: rendered.dirTemplate,
        filenameTemplate: null,
        enabled: 1,
        unlinkOnMismatch: 1,
        priority: 100,
      })
      .run()
    const id = Number(res.lastInsertRowid)
    logEvent(
      db,
      'info',
      `preset '${preset.key}' applied: rule '${name}' -> ${rendered.dirTemplate}`,
      null,
      id,
    )
    const rule = db.select().from(rulesTable).where(eq(rulesTable.id, id)).get()!
    reply.code(201)
    return {
      preset_key: preset.key,
      rule: ruleOut(rule),
      message: `Created rule '${name}'. Edit it as desired.`,
    }
  })
}
