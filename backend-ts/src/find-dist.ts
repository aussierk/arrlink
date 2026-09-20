import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Locates the built SPA bundle relative to this module: <root>/backend-ts/src or
 * dist + <root>/web/dist (repo layout), or /app/dist + /app/web/dist (image layout). */
export function findDist(here: string): string | null {
  const candidates = [
    join(dirname(here), '..', 'web', 'dist'),
    join(dirname(here), '..', '..', 'web', 'dist'),
  ]
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate
  }
  return null
}
