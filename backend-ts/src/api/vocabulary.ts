import { and, eq, isNull, or } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { AdapterError } from '../arr/types.js'
import { getAdapter } from '../arr/factory.js'
import type { Settings } from '../config/env.js'
import type { DbClient } from '../db/client.js'
import { apps, vocabulary as vocabularyTable } from '../db/schema.js'
import type { SettingsStore } from '../db/settings-store.js'
import {
  RICH_CATEGORIES,
  syncTmdbVocabulary,
  syncTrashVocabulary,
  syncVocabularyRows,
} from '../core/vocabulary.js'
import { HttpError } from '../http-error.js'
import { getCurrentUser } from './auth.js'

/** Vocabulary read surface + "refresh now" triggers for the poller's
 * background syncs. Ported from api/vocabulary.py. */

export interface VocabularyRouteOptions {
  db: DbClient
  settingsStore: SettingsStore
  env: Settings
}

export function registerVocabularyRoutes(
  app: FastifyInstance,
  opts: VocabularyRouteOptions,
): void {
  const { db, settingsStore, env } = opts

  // Known values for one scope: shared vocabulary plus this app's own rows.
  app.get('/api/vocabulary', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const q = request.query as { category?: string; appType?: string; appId?: string }
    const category = q.category ?? ''
    const appType = q.appType ?? ''
    if (!RICH_CATEGORIES.has(category)) {
      throw new HttpError(
        422,
        `category must be one of ${[...RICH_CATEGORIES].sort().join(', ')}`,
      )
    }
    const appId = q.appId !== undefined ? Number(q.appId) : null
    const scope =
      appId !== null
        ? or(isNull(vocabularyTable.appId), eq(vocabularyTable.appId, appId))
        : isNull(vocabularyTable.appId)
    const rows = db
      .select({
        value: vocabularyTable.value,
        source: vocabularyTable.source,
        externalId: vocabularyTable.externalId,
        appId: vocabularyTable.appId,
      })
      .from(vocabularyTable)
      .where(
        and(
          eq(vocabularyTable.category, category),
          eq(vocabularyTable.appType, appType),
          scope,
        ),
      )
      .orderBy(vocabularyTable.value)
      .all()
    return rows
  })

  // Force-trigger the poller's daily TMDB sync -- useful right after
  // setting a key override.
  app.post('/api/vocabulary/import/tmdb', async (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const counts = await syncTmdbVocabulary(db, settingsStore)
    if (Object.keys(counts).length === 0) {
      throw new HttpError(
        422,
        'no TMDB API key configured (set one in Settings, or the operator can ' +
          'configure a default via the TMDB_API_KEY env var)',
      )
    }
    return { imported: counts }
  })

  // Force-trigger the TRaSH Guides quality-naming sync for one app type.
  app.post('/api/vocabulary/import/trash', async (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const appType = (request.query as { appType?: string }).appType ?? ''
    if (appType !== 'radarr' && appType !== 'sonarr') {
      throw new HttpError(422, "app_type must be 'radarr' or 'sonarr'")
    }
    const n = await syncTrashVocabulary(db, appType)
    return { imported: n }
  })

  // Force-trigger this app's per-instance sync -- the poller already runs
  // it every poll; this is just for immediate feedback.
  app.post('/api/apps/:appId/vocabulary/sync', async (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const appId = Number((request.params as { appId: string }).appId)
    const row = db.select().from(apps).where(eq(apps.id, appId)).get()
    if (!row) throw new HttpError(404, 'app not found')
    const adapter = getAdapter(row.type, row.url, row.apiKey)
    let items: Awaited<ReturnType<typeof adapter.fetchItems>>
    try {
      items = await adapter.fetchItems()
    } catch (e) {
      const detail = e instanceof AdapterError ? e.detail : String(e)
      throw new HttpError(502, detail)
    }
    const collections = [
      ...new Set(items.map((i) => i.collection).filter((c): c is string => Boolean(c))),
    ].sort()
    syncVocabularyRows(
      db,
      'collection',
      row.type,
      appId,
      collections.map((c): [string, null] => [c, null]),
      'observed',
    )
    const profiles = await adapter.fetchQualityProfiles()
    const languages = await adapter.fetchLanguages()
    syncVocabularyRows(
      db,
      'quality',
      row.type,
      appId,
      profiles.filter((p) => p.name).map((p): [string, string] => [p.name, String(p.id)]),
      'instance',
    )
    syncVocabularyRows(
      db,
      'language',
      row.type,
      appId,
      languages
        .filter((l) => l.name)
        .map((l): [string, string] => [l.name, String(l.id)]),
      'instance',
    )
    return { ok: true }
  })
}
