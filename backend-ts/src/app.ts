import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import fastifyCookie from '@fastify/cookie'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Settings } from './config/env.js'
import { closeDb, openDb, type DbClient } from './db/client.js'
import { runMigrations } from './db/migrate.js'
import { SettingsStore } from './db/settings-store.js'
import { acquireInstanceLock, releaseInstanceLock } from './singleton.js'
import { buildCsp, registerSecurityHeaders } from './security.js'
import { findDist } from './find-dist.js'
import { HttpError } from './http-error.js'
import { registerHealthRoutes } from './api/health.js'
import { registerAuthRoutes } from './api/auth.js'

export interface AppContext {
  app: FastifyInstance
  db: DbClient
  /**
   * Closes the Fastify app, the DB connection, and releases the instance
   * lock. Call exactly once per createApp() call (SIGTERM/SIGINT handler
   * or test teardown) -- ported from main.py's lifespan `finally` block.
   */
  close: () => Promise<void>
}

/**
 * Builds the Fastify app. Ported from main.py::create_app -- acquiring the
 * instance lock is a side effect of *calling* this function, not of
 * importing this module, for the same reason entrypoint.sh's Python
 * equivalent used `uvicorn --factory`: importing app.ts from a test file
 * (or from src/index.ts before main() runs) must never grab a real lock.
 *
 * Route registration is staged across the rollout plan; further routers,
 * background loops, and static/SPA serving land in later stages.
 */
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

  const app = Fastify({ logger: false })
  await app.register(fastifyCookie)

  // Mirrors web/src/lib/api.ts's `req()` helper, which parses `{ detail }`
  // from a non-2xx JSON body -- HttpError is this backend's equivalent of
  // FastAPI's HTTPException(status, detail).
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
  registerSecurityHeaders(app, buildCsp(dist ? join(dist, 'index.html') : null))

  registerHealthRoutes(app, { db })
  registerAuthRoutes(app, { db, settingsStore, env: settings })

  const close = async (): Promise<void> => {
    await app.close()
    closeDb(db)
    await releaseInstanceLock(lockPath)
  }

  return { app, db, close }
}
