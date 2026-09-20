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
} from '../core/presets.js'
import { DEFAULT_ROOTS, TemplateError, checkJail } from '../core/template.js'
import { HttpError } from '../http-error.js'
import { getCurrentUser } from './auth.js'

/** Presets API: list preset rules per app type + apply one (creates an
 * editable rule, jail-validated). Ported from api/presets.py. */

export interface PresetsRouteOptions {
  db: DbClient
  settingsStore: SettingsStore
  env: Settings
}

const APP_TYPES = new Set(['radarr', 'sonarr'])

type RuleRow = typeof rulesTable.$inferSelect

const PresetApplySchema = z.object({
  presetKey: z.string().min(1).max(50),
  appScope: z.number().int().nullable().default(null),
  appType: z.string().min(1).max(20),
  baseFolder: z.string().min(1).max(300).nullable().default(null),
  name: z.string().min(1).max(50).nullable().default(null),
})

function ruleOut(row: RuleRow): Record<string, unknown> {
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
  }
}

export function registerPresetsRoutes(
  app: FastifyInstance,
  opts: PresetsRouteOptions,
): void {
  const { db, settingsStore, env } = opts

  app.get('/api/presets', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const q = request.query as { appType?: string; baseFolder?: string }
    const appType = q.appType ?? ''
    if (!APP_TYPES.has(appType)) {
      throw new HttpError(422, `app_type must be one of ${[...APP_TYPES].join(', ')}`)
    }
    return {
      appType,
      baseFolder: q.baseFolder || defaultBaseFolder(appType),
      presets: listPresetsForType(appType, q.baseFolder),
    }
  })

  app.post('/api/presets/apply', (request, reply) => {
    getCurrentUser(request, db, settingsStore, env)
    const parsed = PresetApplySchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    const body = parsed.data

    const preset = getPreset(body.presetKey)
    if (!preset) throw new HttpError(422, `unknown preset: ${body.presetKey}`)
    if (!APP_TYPES.has(body.appType)) {
      throw new HttpError(422, `app_type must be one of ${[...APP_TYPES].join(', ')}`)
    }
    if (
      body.appScope !== null &&
      !db.select({ id: apps.id }).from(apps).where(eq(apps.id, body.appScope)).get()
    ) {
      throw new HttpError(422, 'app_scope references unknown app')
    }

    const base = (body.baseFolder || defaultBaseFolder(body.appType)).trim()
    if (base.includes('\\') || !base.startsWith('/')) {
      throw new HttpError(422, 'base_folder must be an absolute path')
    }

    const rendered = renderPreset(body.presetKey, body.appType, base)!
    // Path jail: the base folder must stay under an allowed root. Preset
    // subpaths are placeholder-only (resolve to sanitized, separator-free
    // values), so this guarantees the whole resolved tree stays jailed.
    const roots = settingsStore.getSetting<string[]>('allowed_roots') ?? [
      ...DEFAULT_ROOTS,
    ]
    try {
      checkJail(base, roots)
    } catch (e) {
      if (e instanceof TemplateError) throw new HttpError(422, e.message)
      throw e
    }

    const [matchType, matchValue] = preset.matchers[body.appType]
    const name = body.name || `preset:${preset.key}`
    const conditionsJson = JSON.stringify([
      { category: preset.category, matchType, matchValue, join: null },
    ])
    const res = db
      .insert(rulesTable)
      .values({
        name,
        appScope: body.appScope,
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
      presetKey: preset.key,
      rule: ruleOut(rule),
      message: `Created rule '${name}'. Edit it as desired.`,
    }
  })
}
