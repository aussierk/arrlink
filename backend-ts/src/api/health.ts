import { sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import type { DbClient } from '../db/client.js'
import { VERSION } from '../version.js'

interface HealthOptions {
  db: DbClient
}

/** Ported from api/health.py. `schemaVersion` reports the latest Drizzle
 * migration hash (not an int like Python's schema_version), still "db is
 * reachable and migrated" for the HEALTHCHECK. */
export function registerHealthRoutes(app: FastifyInstance, opts: HealthOptions): void {
  app.get('/api/health', () => {
    let dbOk = true
    let schemaVersion: string | null = null
    try {
      const row = opts.db.get<{ hash: string }>(
        sql`SELECT hash FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1`,
      )
      schemaVersion = row?.hash ?? null
    } catch {
      dbOk = false
    }
    return {
      status: dbOk ? 'ok' : 'degraded',
      version: VERSION,
      schemaVersion,
      db: dbOk ? 'ok' : 'error',
    }
  })
}
