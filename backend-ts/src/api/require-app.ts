import { eq } from 'drizzle-orm'
import type { DbClient } from '../db/client.js'
import { apps } from '../db/schema.js'
import { HttpError } from '../http-error.js'

/** Fetches the app row or throws the standard 404 -- shared by apps.ts and tags.ts,
 * which each look this up repeatedly (sometimes as an existence-only check). */
export function requireApp(db: DbClient, appId: number) {
  const row = db.select().from(apps).where(eq(apps.id, appId)).get()
  if (!row) throw new HttpError(404, 'app not found')
  return row
}
