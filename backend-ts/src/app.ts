import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import fastifyCompress from '@fastify/compress'
import fastifyCookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Settings } from './config/env.js'
import { closeDb, openDb, type DbClient } from './db/client.js'
import { logEvent } from './db/events.js'
import { runMigrations } from './db/migrate.js'
import { rules as rulesTable } from './db/schema.js'
import { SettingsStore } from './db/settings-store.js'
import { acquireInstanceLock, releaseInstanceLock } from './singleton.js'
import { buildCsp, registerSecurityHeaders } from './security.js'
import { findDist } from './find-dist.js'
import { HttpError } from './http-error.js'
import { registerTrustedHost } from './plugins/trusted-host.js'
import { registerDevCors } from './plugins/cors.js'
import { registerStaticRoutes } from './plugins/static.js'
import { registerHealthRoutes } from './api/health.js'
import { registerAuthRoutes } from './api/auth.js'
import { registerAppsRoutes } from './api/apps.js'
import { registerTagsRoutes } from './api/tags.js'
import { registerRulesRoutes } from './api/rules.js'
import { registerSettingsRoutes } from './api/settings.js'
import { registerLinksRoutes } from './api/links.js'
import { registerPresetsRoutes } from './api/presets.js'
import { registerBackupRoutes } from './api/backup.js'
import { registerVocabularyRoutes } from './api/vocabulary.js'
import { registerLogsRoutes } from './api/logs.js'
import { Poller } from './core/poller.js'
import { authSweepLoop, backupLoop } from './core/background-loops.js'
import { DEFAULT_ROOTS, auditRuleRoots } from './core/template.js'

export interface AppContext {
  app: FastifyInstance
  db: DbClient
  /** Closes the app, DB, and instance lock. Call exactly once per createApp() call. */
  close: () => Promise<void>
}

/** Builds the Fastify app. Acquiring the instance lock is a side effect of
 * *calling* this function, not of importing this module -- importing app.ts
 * from a test file must never grab a real lock. */
export async function createApp(settings: Settings): Promise<AppContext> {
  const dbDir = dirname(settings.dbPath)
  const lockPath = await acquireInstanceLock(dbDir)

  let db: DbClient
  try {
    db = openDb(settings.dbPath)
    runMigrations(db)
  } catch (err) {
    await releaseInstanceLock(lockPath)
    throw err
  }
  const settingsStore = new SettingsStore(db)

  const app = Fastify({ logger: false, trustProxy: settings.forwardedAllowIps })
  await app.register(fastifyCookie)

  // web/src/lib/api.ts's req() helper parses `{ detail }` from error bodies.
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof HttpError) {
      reply.code(err.status).send({ detail: err.detail })
      return
    }
    app.log.error(err)
    reply.code(500).send({ detail: 'internal server error' })
  })

  const here = fileURLToPath(import.meta.url)
  const dist = findDist(here)

  // Same order as main.py: trusted-host -> dev-CORS -> gzip -> security-headers.
  registerTrustedHost(app, settings.trustedHosts)
  if (settings.enableDevCors) registerDevCors(app)
  await app.register(fastifyCompress, { threshold: 1024 })
  registerSecurityHeaders(app, buildCsp(dist ? join(dist, 'index.html') : null))

  const poller = new Poller(db, settings)
  const routeOpts = { db, settingsStore, env: settings }

  registerHealthRoutes(app, { db })
  registerAuthRoutes(app, routeOpts)
  registerAppsRoutes(app, { ...routeOpts, getPoller: () => poller })
  registerTagsRoutes(app, routeOpts)
  registerRulesRoutes(app, routeOpts)
  registerSettingsRoutes(app, routeOpts)
  registerLinksRoutes(app, routeOpts)
  registerPresetsRoutes(app, routeOpts)
  registerBackupRoutes(app, routeOpts)
  registerVocabularyRoutes(app, routeOpts)
  registerLogsRoutes(app, routeOpts)

  // Static/SPA catch-all last, so it only shadows routes that don't exist.
  if (dist) await registerStaticRoutes(app, dist)

  const ruleRows = db
    .select({ name: rulesTable.name, dirTemplate: rulesTable.dirTemplate })
    .from(rulesTable)
    .where(eq(rulesTable.enabled, 1))
    .all()
  const roots = settingsStore.getSetting<string[]>('allowed_roots') ?? [...DEFAULT_ROOTS]
  const badRules = auditRuleRoots(ruleRows, roots)
  if (badRules.length > 0) {
    logEvent(
      db,
      'warn',
      `rule(s) outside the allowed roots, will not link until fixed: ${badRules.join(', ')} ` +
        '(set allowed_roots or edit the rules)',
    )
  }

  poller.start()

  const authSweepAbort = new AbortController()
  const backupLoopAbort = new AbortController()
  const authSweepDone = authSweepLoop(db, settingsStore, settings, authSweepAbort.signal)
  const backupLoopDone = backupLoop(db, settingsStore, settings, backupLoopAbort.signal)

  const close = async (): Promise<void> => {
    poller.stop()
    authSweepAbort.abort()
    backupLoopAbort.abort()
    // abort() only stops the loop *after* its current iteration -- backupLoop
    // in particular opens its own separate sqlite handle for the online
    // backup, so waiting here (not just fire-and-forget) matters: closing
    // the main db / removing the config dir while that handle is still open
    // fails hard on Windows (EBUSY).
    await Promise.all([authSweepDone, backupLoopDone])
    await app.close()
    closeDb(db)
    await releaseInstanceLock(lockPath)
  }

  return { app, db, close }
}
