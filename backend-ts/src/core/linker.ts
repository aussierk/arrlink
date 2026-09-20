import { dirname } from 'node:path'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Stats } from 'node:fs'
import { scandirStats } from '../arr/scandir-stats.js'
import type { FsFallbackMode } from '../config/env.js'
import type { DbClient } from '../db/client.js'
import { links, rules as rulesTable } from '../db/schema.js'
import { createLink, ensureDir, inodeOf, removeLink } from './fsutil.js'
import type { PlannedLink } from './planner.js'

/** The hardlink reconciler. Ported from core/linker.py. Chunked BEGIN/COMMIT
 * releases the WAL writer lock between batches and bounds a mid-loop failure
 * to one batch; the next poll re-reconciles the rest. */

export const DEFAULT_DELETE_AFTER = 3

// Mutable so tests can shrink it (mirrors Python's COMMIT_BATCH monkeypatch).
export const RECONCILE_TUNABLES = { commitBatch: 500 }

export interface ReconcileResult {
  created: number
  removed: number
  moved: number
  errors: string[]
}

type LinkRow = typeof links.$inferSelect
type RuleRow = typeof rulesTable.$inferSelect

/** Inode from the pre-scanned cache, else a live stat. */
function cachedIno(path: string, cache: Map<string, Stats>): number | null {
  const st = cache.get(path)
  return st !== undefined ? st.ino : inodeOf(path)
}

/** Runs `fn` for each item, committing every `commitBatch` items instead of one big transaction. */
function withChunkedCommits<T>(
  db: DbClient,
  items: T[],
  fn: (item: T, index: number) => void,
): void {
  const raw = db.$client
  raw.exec('BEGIN')
  try {
    items.forEach((item, i) => {
      if (i > 0 && i % RECONCILE_TUNABLES.commitBatch === 0) {
        raw.exec('COMMIT')
        raw.exec('BEGIN')
      }
      fn(item, i)
    })
    raw.exec('COMMIT')
  } catch (e) {
    raw.exec('ROLLBACK')
    throw e
  }
}

/** Reconcile stored links for one app against the current plan. */
export function reconcile(
  db: DbClient,
  appId: number,
  _appName: string,
  plan: PlannedLink[],
  liveSrcs: Set<string>,
  unlinkOnMismatch: boolean,
  fallback: FsFallbackMode = 'skip',
  now: number = Date.now() / 1000,
  deleteAfter: number = DEFAULT_DELETE_AFTER,
): ReconcileResult {
  const res: ReconcileResult = { created: 0, removed: 0, moved: 0, errors: [] }

  const planned = new Map<string, PlannedLink>()
  for (const p of plan) {
    if (p.fileId !== null) planned.set(planKey(p.ruleId, p.fileId, p.matchKey), p)
  }

  // Flag two different rules planning the same dst_path, naming both --
  // createLink() would eventually catch this too, but only as a generic
  // "name collision" with no indication of which rules are fighting.
  const seenDsts = new Map<string, [number, number | null]>()
  for (const p of plan) {
    const prev = seenDsts.get(p.dstPath)
    if (prev === undefined) {
      seenDsts.set(p.dstPath, [p.ruleId, p.fileId])
    } else if (prev[0] !== p.ruleId || prev[1] !== p.fileId) {
      res.errors.push(
        `${p.dstPath}: rule ${prev[0]} and rule ${p.ruleId} both plan to link here -- ` +
          'only one can occupy this destination; check for overlapping rules',
      )
    }
  }

  const rows = db
    .select()
    .from(links)
    .where(and(eq(links.appId, appId), inArray(links.status, ['active', 'stale'])))
    .all()

  // One lookup for all rules, instead of a per-row query inside retire().
  const rulesById = new Map<number, RuleRow>(
    db
      .select()
      .from(rulesTable)
      .all()
      .map((r) => [r.id, r]),
  )

  // Batch-stat every link's dst + src (plus any planned src missing its
  // snapshot inode) with one directory listing per directory, taken before
  // pass 1 mutates anything.
  const statCache = scandirStats([
    ...rows.map((r) => r.dstPath),
    ...rows.map((r) => r.srcPath),
    ...[...planned.values()].filter((p) => p.srcInode === null).map((p) => p.srcPath),
  ])

  // --- pass 1: links we already have -------------------------------------
  withChunkedCommits(db, rows, (row) => {
    const key = planKey(row.ruleId, row.fileId, row.matchKey || '')
    const dst = row.dstPath
    const src = row.srcPath

    const p = planned.get(key)
    if (p !== undefined) {
      planned.delete(key)
      if (p.dstPath === dst) {
        ensurePresent(db, row, dst, p, res, fallback, now, statCache)
      } else {
        // dst changed (file renamed/moved, or template edited) -> recreate
        // under the new dst, drop the old
        const r = removeLink(dst)
        if (!r.ok && r.error) res.errors.push(`old link ${dst}: ${r.error}`)
        if (p.fileId !== null) create(db, p, appId, res, fallback, now)
        res.moved += 1
      }
      return
    }

    // key not in plan: rule no longer matches / file deleted
    retire(
      db,
      row,
      src,
      dst,
      liveSrcs,
      unlinkOnMismatch,
      res,
      deleteAfter,
      rulesById,
      statCache,
    )
  })

  // --- pass 2: links that should exist but don't --------------------------
  const remaining = [...planned.values()]
  withChunkedCommits(db, remaining, (p) => {
    if (p.fileId === null) return
    create(db, p, appId, res, fallback, now)
  })

  return res
}

function planKey(ruleId: number | null, fileId: number | null, matchKey: string): string {
  return JSON.stringify([ruleId, fileId, matchKey])
}

/** Keep an already-placed link valid (idempotent). */
function ensurePresent(
  db: DbClient,
  row: LinkRow,
  dst: string,
  p: PlannedLink,
  res: ReconcileResult,
  fallback: FsFallbackMode,
  now: number,
  statCache: Map<string, Stats>,
): void {
  const src = p.srcPath
  const srcIno = p.srcInode !== null ? p.srcInode : cachedIno(src, statCache)
  const dstIno = cachedIno(dst, statCache)

  if (dstIno === null) {
    // dst vanished on disk: re-create if the source still exists
    if (srcIno !== null) {
      const r = createLink(src, dst, fallback)
      if (r.ok) {
        res.created += 1
        db.update(links)
          .set({
            status: 'active',
            inode: inodeOf(dst),
            srcPath: src,
            missingStrikes: 0,
            createdAt: now,
          })
          .where(eq(links.id, row.id))
          .run()
      } else {
        res.errors.push(`${dst}: ${r.error}`)
      }
    } else {
      db.update(links).set({ status: 'stale' }).where(eq(links.id, row.id)).run()
    }
    return
  }

  if (dstIno !== srcIno) {
    // source was replaced (e.g. quality upgrade): re-link under the same
    // dst name. The old file's data survives until this unlink.
    const r = removeLink(dst)
    if (r.ok && srcIno !== null) {
      const r2 = createLink(src, dst, fallback)
      if (r2.ok) {
        res.moved += 1
        db.update(links)
          .set({ inode: inodeOf(dst), srcPath: src, missingStrikes: 0 })
          .where(eq(links.id, row.id))
          .run()
      } else {
        res.errors.push(`${dst}: ${r2.error}`)
      }
    }
    return
  }

  // already correct; keep stored metadata in sync
  if (dstIno !== row.inode || src !== row.srcPath) {
    db.update(links)
      .set({ inode: dstIno, srcPath: src, missingStrikes: 0 })
      .where(eq(links.id, row.id))
      .run()
  }
}

/** Remove (or defer) a link that is no longer planned. */
function retire(
  db: DbClient,
  row: LinkRow,
  src: string,
  dst: string,
  liveSrcs: Set<string>,
  unlinkOnMismatch: boolean,
  res: ReconcileResult,
  deleteAfter: number,
  rulesById: Map<number, RuleRow>,
  statCache: Map<string, Stats>,
): void {
  const rule = row.ruleId !== null ? rulesById.get(row.ruleId) : undefined
  const ruleUnlink = rule ? Boolean(rule.unlinkOnMismatch) : unlinkOnMismatch
  const srcExists = liveSrcs.has(src) && cachedIno(src, statCache) !== null

  if (!srcExists) {
    // source gone: grace period before we treat it as deleted
    const strikes = (row.missingStrikes || 0) + 1
    if (row.status === 'active' && strikes < deleteAfter) {
      db.update(links).set({ missingStrikes: strikes }).where(eq(links.id, row.id)).run()
      return
    }
  } else if (!ruleUnlink) {
    // source still there but rule no longer matches; user opted out of
    // auto-unlink -> keep it (mark stale so the UI can show it)
    db.update(links).set({ status: 'stale' }).where(eq(links.id, row.id)).run()
    return
  }

  const r = removeLink(dst)
  if (r.ok) res.removed += 1
  else res.errors.push(`remove ${dst}: ${r.error}`)
  db.update(links).set({ status: 'missing' }).where(eq(links.id, row.id)).run()
}

/** Create one planned link (idempotent). */
function create(
  db: DbClient,
  p: PlannedLink,
  appId: number,
  res: ReconcileResult,
  fallback: FsFallbackMode,
  now: number,
): void {
  const parent = dirname(p.dstPath)
  if (!ensureDir(parent)) {
    res.errors.push(`${p.dstPath}: cannot create parent dir ${parent}`)
    return
  }
  const r = createLink(p.srcPath, p.dstPath, fallback)
  if (r.ok) {
    res.created += 1
    // Clean up a dead grace-deleted row at this dst_path (item_id/file_id
    // nulled out) -- NULL never equals NULL in the ON CONFLICT target below,
    // so it would otherwise sit forever once this destination is relinked.
    db.delete(links)
      .where(
        and(
          eq(links.appId, appId),
          eq(links.dstPath, p.dstPath),
          eq(links.status, 'missing'),
          isNull(links.itemId),
          isNull(links.fileId),
        ),
      )
      .run()
    db.insert(links)
      .values({
        ruleId: p.ruleId,
        appId,
        itemId: p.itemId,
        fileId: p.fileId,
        srcPath: p.srcPath,
        dstPath: p.dstPath,
        inode: inodeOf(p.dstPath),
        status: 'active',
        createdAt: now,
        missingStrikes: 0,
        matchKey: p.matchKey,
      })
      .onConflictDoUpdate({
        target: [links.ruleId, links.itemId, links.fileId, links.matchKey],
        set: {
          dstPath: p.dstPath,
          srcPath: p.srcPath,
          inode: inodeOf(p.dstPath),
          status: 'active',
          createdAt: now,
          missingStrikes: 0,
        },
      })
      .run()
  } else {
    res.errors.push(`${p.dstPath}: ${r.error}`)
  }
}
