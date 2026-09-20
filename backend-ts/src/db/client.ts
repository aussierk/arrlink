import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

export type DbClient = ReturnType<typeof drizzle<typeof schema>>

// Ported 1:1 from state.py::_init_connection. better-sqlite3 is
// synchronous and single-connection-per-process, so unlike the Python
// version there is no thread-local connection pool to manage here -- see
// the plan's "Background jobs" section for why that's a simplification,
// not a gap.
export function openDb(dbPath: string): DbClient {
  mkdirSync(dirname(dbPath), { recursive: true })
  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('synchronous = NORMAL')
  sqlite.pragma('wal_autocheckpoint = 1000')
  sqlite.pragma('cache_size = -16000') // ~16 MiB page cache
  return drizzle(sqlite, { schema })
}

/** Closes the underlying better-sqlite3 connection (tests, graceful shutdown). */
export function closeDb(db: DbClient): void {
  db.$client.close()
}
