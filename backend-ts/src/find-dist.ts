import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Locates the built SPA bundle relative to this module.
 *
 * Repo layout:  <root>/backend-ts/src/app.ts (dev) or dist/app.js (built) + <root>/web/dist
 * Image layout: /app/dist/app.js                                        + /app/web/dist
 *
 * Ported from main.py::find_dist -- same two-candidate-parent-directory
 * search, adjusted for backend-ts's one-level-shallower module nesting.
 */
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
