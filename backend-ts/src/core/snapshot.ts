import { eq } from 'drizzle-orm'
import type { DbClient } from '../db/client.js'
import { appFiles, appItems } from '../db/schema.js'
import type { Item, MediaFile } from '../arr/types.js'

/** Rebuild adapter-shaped Item/MediaFile objects from the poller's stored snapshot.
 * Ported from core/snapshot.py. */

/** Every stored item, with files attached. [] if never polled -- callers fall back to live fetch. */
export function snapshotItems(db: DbClient, appId: number): Item[] {
  const itemRows = db.select().from(appItems).where(eq(appItems.appId, appId)).all()

  const filesByItemDbId = new Map<number, MediaFile[]>()
  for (const { app_files: f } of db
    .select({ app_files: appFiles })
    .from(appFiles)
    .innerJoin(appItems, eq(appFiles.itemId, appItems.id))
    .where(eq(appItems.appId, appId))
    .all()) {
    const list = filesByItemDbId.get(f.itemId)
    const file: MediaFile = {
      relPath: f.relPath,
      absPath: f.absPath,
      size: f.size,
      mtime: f.mtime,
      inode: f.inode,
      id: f.id,
    }
    if (list) list.push(file)
    else filesByItemDbId.set(f.itemId, [file])
  }

  return itemRows.map((r): Item => ({
    id: r.itemId,
    title: r.title,
    year: r.year,
    tags: JSON.parse(r.tagsJson || '[]') as string[],
    path: r.path || '',
    files: filesByItemDbId.get(r.id) ?? [],
    genres: JSON.parse(r.genresJson || '[]') as string[],
    certification: r.certification,
    collection: r.collection,
    qualityProfileId: r.qualityProfileId,
    qualityProfileName: r.qualityProfileName,
    originalLanguage: r.originalLanguage,
  }))
}
