import { and, eq, notInArray } from 'drizzle-orm'
import type { DbClient } from './client.js'
import { tags as tagsTable } from './schema.js'
import type { Tag } from '../arr/types.js'

/** Full-replace: the poller's tag fetch is the app's complete vocabulary, so
 * tags the app no longer reports are cleared. Ported from state.py::sync_app_tags. */
export function syncAppTags(db: DbClient, appId: number, tags: Tag[]): number {
  const now = Date.now() / 1000
  const labels = tags.map((t) => t.label)
  if (labels.length > 0) {
    db.delete(tagsTable)
      .where(and(eq(tagsTable.appId, appId), notInArray(tagsTable.label, labels)))
      .run()
  } else {
    db.delete(tagsTable).where(eq(tagsTable.appId, appId)).run()
  }
  for (const t of tags) {
    db.insert(tagsTable)
      .values({ appId, label: t.label, count: t.count, importedAt: now })
      .onConflictDoUpdate({
        target: [tagsTable.appId, tagsTable.label],
        set: { count: t.count, importedAt: now },
      })
      .run()
  }
  return tags.length
}
