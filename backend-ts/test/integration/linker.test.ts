import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, openDb, type DbClient } from '../../src/db/client.js'
import { runMigrations } from '../../src/db/migrate.js'
import {
  appFiles,
  appItems,
  apps,
  links as linksTable,
  rules as rulesTable,
} from '../../src/db/schema.js'
import { RECONCILE_TUNABLES, reconcile } from '../../src/core/linker.js'
import type { PlannedLink } from '../../src/core/planner.js'
import { inodeOf } from '../../src/core/fsutil.js'

let dir: string
let mediaDir: string
let linkedDir: string
let db: DbClient
let appId: number
let ruleId: number
let itemId: number
let defaultFileId: number

/** links.item_id/file_id are real foreign keys (ON DELETE CASCADE) -- every
 * plan used in these tests needs a matching app_items/app_files row, the
 * same way the real poller creates them before ever calling reconcile. */
function makeFile(relPath: string): number {
  return db
    .insert(appFiles)
    .values({ itemId, relPath, absPath: join(mediaDir, relPath) })
    .run().lastInsertRowid as number
}

beforeEach(() => {
  // linker.ts uses the native path module (this backend targets native
  // deployment on any host OS, not just Docker/Linux -- see template.ts),
  // so plain native path.join throughout is correct here, unlike the
  // POSIX-forced version this test used to work around.
  dir = mkdtempSync(join(tmpdir(), 'arrlink-linker-'))
  mediaDir = join(dir, 'media')
  linkedDir = join(dir, 'linked')
  mkdirSync(mediaDir, { recursive: true })
  mkdirSync(linkedDir, { recursive: true })
  db = openDb(join(dir, 'arrlink.db'))
  runMigrations(db)
  RECONCILE_TUNABLES.commitBatch = 500

  appId = db
    .insert(apps)
    .values({ name: 'Radarr', type: 'radarr', url: 'http://x', apiKey: 'k' })
    .run().lastInsertRowid as number
  ruleId = db
    .insert(rulesTable)
    .values({ name: 'kids', dirTemplate: join(linkedDir, 'kids') })
    .run().lastInsertRowid as number
  itemId = db
    .insert(appItems)
    .values({ appId, itemId: 1, title: 'T', firstSeen: 0, lastSeen: 0 })
    .run().lastInsertRowid as number
  defaultFileId = makeFile('a.mkv')
})

afterEach(() => {
  RECONCILE_TUNABLES.commitBatch = 500
  closeDb(db)
  rmSync(dir, { recursive: true, force: true })
})

function plan(overrides: Partial<PlannedLink> = {}): PlannedLink {
  return {
    ruleId,
    ruleName: 'kids',
    itemId,
    itemTitle: 'T',
    srcPath: join(mediaDir, 'a.mkv'),
    dstPath: join(linkedDir, 'kids', 'a.mkv'),
    fileId: defaultFileId,
    srcInode: null,
    matchKey: '',
    ...overrides,
  }
}

describe('reconcile: create', () => {
  it('creates a real hardlink for a newly planned file', () => {
    const src = join(mediaDir, 'a.mkv')
    writeFileSync(src, 'hello')
    const dst = join(linkedDir, 'kids', 'a.mkv')

    const res = reconcile(db, appId, 'Radarr', [plan()], new Set([src]), true, [
      linkedDir,
    ])
    expect(res).toMatchObject({ created: 1, removed: 0, moved: 0, errors: [] })
    expect(existsSync(dst)).toBe(true)
    expect(inodeOf(src)).toBe(inodeOf(dst))

    const rows = db.select().from(linksTable).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'active', dstPath: dst, srcPath: src })
  })

  it('is idempotent across repeated reconciles with no changes', () => {
    const src = join(mediaDir, 'a.mkv')
    writeFileSync(src, 'hello')
    const p = plan({ srcPath: src })

    reconcile(db, appId, 'Radarr', [p], new Set([src]), true, [linkedDir])
    const res2 = reconcile(db, appId, 'Radarr', [p], new Set([src]), true, [linkedDir])
    expect(res2).toMatchObject({ created: 0, removed: 0, moved: 0, errors: [] })
    expect(db.select().from(linksTable).all()).toHaveLength(1)
  })

  it('reports a plan error via res.errors when the parent dir cannot be made and skips it', () => {
    const src = join(mediaDir, 'a.mkv')
    writeFileSync(src, 'hello')
    // Use a destination whose parent is actually a FILE, so mkdir fails.
    const blocker = join(linkedDir, 'blocker')
    writeFileSync(blocker, 'x')
    const p = plan({ srcPath: src, dstPath: join(blocker, 'a.mkv') })

    const res = reconcile(db, appId, 'Radarr', [p], new Set([src]), true, [linkedDir])
    expect(res.created).toBe(0)
    expect(res.errors).toHaveLength(1)
  })
})

describe('reconcile: rename', () => {
  it('relinks under the new destination and removes the old one, preserving inode', () => {
    const src = join(mediaDir, 'a.mkv')
    writeFileSync(src, 'hello')
    const oldDst = join(linkedDir, 'kids', 'a.mkv')
    reconcile(db, appId, 'Radarr', [plan({ srcPath: src })], new Set([src]), true, [
      linkedDir,
    ])
    const oldIno = inodeOf(oldDst)

    const newDst = join(linkedDir, 'kids', 'b.mkv')
    const res = reconcile(
      db,
      appId,
      'Radarr',
      [plan({ srcPath: src, dstPath: newDst })],
      new Set([src]),
      true,
      [linkedDir],
    )
    expect(res.moved).toBe(1)
    expect(existsSync(oldDst)).toBe(false)
    expect(existsSync(newDst)).toBe(true)
    expect(inodeOf(newDst)).toBe(oldIno)
  })
})

describe('reconcile: source replaced (quality upgrade)', () => {
  it('re-links the same destination to the new inode', () => {
    const src = join(mediaDir, 'a.mkv')
    writeFileSync(src, 'hello')
    const dst = join(linkedDir, 'kids', 'a.mkv')
    reconcile(db, appId, 'Radarr', [plan({ srcPath: src })], new Set([src]), true, [
      linkedDir,
    ])
    const oldIno = inodeOf(dst)

    rmSync(src)
    writeFileSync(src, 'new higher quality data')
    const res = reconcile(
      db,
      appId,
      'Radarr',
      [plan({ srcPath: src })],
      new Set([src]),
      true,
      [linkedDir],
    )
    expect(res.moved).toBe(1)
    expect(inodeOf(dst)).toBe(inodeOf(src))
    expect(inodeOf(dst)).not.toBe(oldIno)
  })
})

describe('reconcile: retire (missing source)', () => {
  it('grants a 3-poll grace period before removing the link', () => {
    const src = join(mediaDir, 'a.mkv')
    writeFileSync(src, 'hello')
    const dst = join(linkedDir, 'kids', 'a.mkv')
    reconcile(db, appId, 'Radarr', [plan({ srcPath: src })], new Set([src]), true, [
      linkedDir,
    ])

    // no plan this time (item gone), source also removed from the live set
    rmSync(src)
    reconcile(db, appId, 'Radarr', [], new Set(), true, [linkedDir])
    expect(existsSync(dst)).toBe(true) // miss 1
    reconcile(db, appId, 'Radarr', [], new Set(), true, [linkedDir])
    expect(existsSync(dst)).toBe(true) // miss 2
    const res = reconcile(db, appId, 'Radarr', [], new Set(), true, [linkedDir])
    expect(existsSync(dst)).toBe(false) // miss 3 -> removed
    expect(res.removed).toBe(1)

    const row = db.select().from(linksTable).all()[0]
    expect(row.status).toBe('missing')
  })

  it('keeps a stale (not removed) link when unlink_on_mismatch is off', () => {
    const src = join(mediaDir, 'a.mkv')
    writeFileSync(src, 'hello')
    const dst = join(linkedDir, 'kids', 'a.mkv')
    reconcile(db, appId, 'Radarr', [plan({ srcPath: src })], new Set([src]), true, [
      linkedDir,
    ])
    db.update(rulesTable)
      .set({ unlinkOnMismatch: 0 })
      .where(eq(rulesTable.id, ruleId))
      .run()

    // source still exists but no longer planned (rule no longer matches)
    const res = reconcile(db, appId, 'Radarr', [], new Set([src]), true, [linkedDir])
    expect(existsSync(dst)).toBe(true)
    expect(res.removed).toBe(0)
    const row = db.select().from(linksTable).all()[0]
    expect(row.status).toBe('stale')
  })
})

describe('reconcile: collision', () => {
  it('skips a destination already occupied by a foreign file and reports it via fsutil, not a crash', () => {
    const src = join(mediaDir, 'a.mkv')
    writeFileSync(src, 'hello')
    const dst = join(linkedDir, 'kids', 'a.mkv')
    mkdirSync(join(linkedDir, 'kids'), { recursive: true })
    writeFileSync(dst, "someone else's file")

    const res = reconcile(
      db,
      appId,
      'Radarr',
      [plan({ srcPath: src })],
      new Set([src]),
      true,
      [linkedDir],
    )
    expect(res.created).toBe(0)
    expect(res.errors).toHaveLength(1)
    expect(readFileSync(dst, 'utf-8')).toBe("someone else's file")
    expect(db.select().from(linksTable).all()).toHaveLength(0)
  })
})

describe('reconcile: overlapping rules', () => {
  it('flags two different (rule, file) plans targeting the same destination', () => {
    const src = join(mediaDir, 'a.mkv')
    writeFileSync(src, 'hello')
    const dst = join(linkedDir, 'kids', 'a.mkv')
    const otherRuleId = db
      .insert(rulesTable)
      .values({ name: 'other', dirTemplate: join(linkedDir, 'other') })
      .run().lastInsertRowid as number

    const res = reconcile(
      db,
      appId,
      'Radarr',
      [
        plan({ srcPath: src, dstPath: dst }),
        plan({ ruleId: otherRuleId, srcPath: src, dstPath: dst }),
      ],
      new Set([src]),
      true,
      [linkedDir],
    )
    expect(res.errors.some((e) => e.includes('both plan to link here'))).toBe(true)
  })
})

describe('reconcile: dead missing-row cleanup', () => {
  it('lets a destination be legitimately re-occupied after a prior grace-deleted (missing, nulled) row', () => {
    const src = join(mediaDir, 'a.mkv')
    writeFileSync(src, 'hello')
    const dst = join(linkedDir, 'kids', 'a.mkv')

    // Simulate a prior grace-deleted link: a 'missing' row with item/file
    // ids nulled out (as poller.ts leaves behind), at the same dst_path.
    db.insert(linksTable)
      .values({
        ruleId: null,
        appId,
        itemId: null,
        fileId: null,
        srcPath: src,
        dstPath: dst,
        status: 'missing',
        createdAt: Date.now() / 1000,
        matchKey: '',
      })
      .run()

    const res = reconcile(
      db,
      appId,
      'Radarr',
      [plan({ srcPath: src, dstPath: dst })],
      new Set([src]),
      true,
      [linkedDir],
    )
    expect(res.created).toBe(1)
    const rows = db.select().from(linksTable).all()
    expect(rows).toHaveLength(1) // the dead row was cleaned up, not left as a zombie
    expect(rows[0].status).toBe('active')
  })
})

describe('reconcile: chunked commits', () => {
  it('commits mid-pass when commitBatch is smaller than the row count', () => {
    RECONCILE_TUNABLES.commitBatch = 1
    const names = ['x.mkv', 'y.mkv', 'z.mkv']
    const srcs = names.map((n) => join(mediaDir, n))
    for (const s of srcs) writeFileSync(s, 'x')
    const fileIds = names.map((n) => makeFile(n))
    const plans = srcs.map((s, i) =>
      plan({
        fileId: fileIds[i],
        srcPath: s,
        dstPath: join(linkedDir, 'kids', `${i}.mkv`),
      }),
    )
    reconcile(db, appId, 'Radarr', plans, new Set(srcs), true, [linkedDir])

    // Re-run pass 1 over the now-existing 3 rows with a real $client.exec
    // spy to confirm more than one COMMIT was issued.
    let commits = 0
    const rawExec = db.$client.exec.bind(db.$client)
    db.$client.exec = (sql: string) => {
      if (sql === 'COMMIT') commits += 1
      return rawExec(sql)
    }
    try {
      reconcile(db, appId, 'Radarr', plans, new Set(srcs), true, [linkedDir])
    } finally {
      db.$client.exec = rawExec
    }
    expect(commits).toBeGreaterThanOrEqual(2)
  })
})
