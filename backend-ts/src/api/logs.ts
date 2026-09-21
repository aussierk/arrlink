import { and, desc, eq, gt } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Settings } from '../config/env.js'
import type { DbClient } from '../db/client.js'
import { events } from '../db/schema.js'
import { logEvent } from '../db/events.js'
import type { SettingsStore } from '../db/settings-store.js'
import { HttpError } from '../http-error.js'
import { getCurrentUser } from './auth.js'

/** Event log endpoints + SSE live stream. Ported from api/logs.py.
 * Wire format is snake_case throughout, matching web/ and the Python backend. */

export interface LogsRouteOptions {
  db: DbClient
  settingsStore: SettingsStore
  env: Settings
}

const POLL_INTERVAL_MS = 3000

const ClientErrorSchema = z.object({
  message: z.string().min(1).max(500),
  level: z.enum(['error', 'warn', 'info']).default('error'),
  url: z.string().max(300).default(''),
  stack: z.string().max(2000).default(''),
})

type EventRow = typeof events.$inferSelect

function eventOut(row: EventRow): Record<string, unknown> {
  return {
    id: row.id,
    ts: row.ts,
    level: row.level,
    app_id: row.appId,
    rule_id: row.ruleId,
    message: row.message,
  }
}

function sseLine(row: EventRow): string {
  return `id: ${row.id}\ndata: ${JSON.stringify(eventOut(row))}\n\n`
}

export function registerLogsRoutes(app: FastifyInstance, opts: LogsRouteOptions): void {
  const { db, settingsStore, env } = opts

  // Records a frontend exception into the event log, same as any backend event.
  app.post('/api/logs', (request, reply) => {
    getCurrentUser(request, db, settingsStore, env)
    const parsed = ClientErrorSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    const body = parsed.data
    let msg = `[web] ${body.message}`
    if (body.url) msg += ` @ ${body.url}`
    if (body.stack) msg += ` | ${body.stack.split('\n')[0]}`
    logEvent(db, body.level, msg.slice(0, 1000))
    reply.code(204).send()
  })

  app.get('/api/logs', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const q = request.query as {
      level?: string
      app_id?: string
      rule_id?: string
      limit?: string
    }
    const limit = Math.min(
      1000,
      Math.max(1, q.limit !== undefined ? Number(q.limit) : 100),
    )
    const conditions = []
    if (q.level) conditions.push(eq(events.level, q.level))
    if (q.app_id !== undefined) conditions.push(eq(events.appId, Number(q.app_id)))
    if (q.rule_id !== undefined) conditions.push(eq(events.ruleId, Number(q.rule_id)))
    return db
      .select()
      .from(events)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(events.id))
      .limit(limit)
      .all()
      .map(eventOut)
  })

  // SSE: initial 50 events, then live. `limit` bounds it for tests; omitted = infinite.
  app.get('/api/logs/stream', (request, reply) => {
    getCurrentUser(request, db, settingsStore, env)
    const q = request.query as { limit?: string }
    const limit = q.limit !== undefined ? Number(q.limit) : null

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    const initial = db
      .select()
      .from(events)
      .orderBy(desc(events.id))
      .limit(50)
      .all()
      .reverse()
    let lastId = 0
    let sent = 0
    for (const row of initial) {
      lastId = row.id
      reply.raw.write(sseLine(row))
      sent += 1
      if (limit !== null && sent >= limit) {
        reply.raw.end()
        return
      }
    }
    if (limit !== null) {
      reply.raw.end()
      return
    }

    const timer = setInterval(() => {
      const fresh = db
        .select()
        .from(events)
        .where(gt(events.id, lastId))
        .orderBy(events.id)
        .all()
      if (fresh.length > 0) {
        for (const row of fresh) {
          lastId = row.id
          reply.raw.write(sseLine(row))
        }
      } else {
        reply.raw.write(': keep-alive\n\n')
      }
    }, POLL_INTERVAL_MS)

    request.raw.on('close', () => {
      clearInterval(timer)
    })
  })
}
