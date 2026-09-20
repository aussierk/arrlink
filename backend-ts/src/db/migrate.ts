import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { openDb } from './client.js'

const here = dirname(fileURLToPath(import.meta.url))

export function runMigrations(db: ReturnType<typeof openDb>): void {
  migrate(db, { migrationsFolder: join(here, 'migrations') })
}

// Allows `npm run db:migrate -- <path-to-db>` for local/manual use; the
// server itself calls runMigrations() directly from app.ts at boot.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dbPath = process.argv[2] ?? 'config/arrlink.db'
  const db = openDb(dbPath)
  runMigrations(db)
  console.log(`migrated ${dbPath}`)
}
