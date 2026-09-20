import { readdirSync, statSync, type Stats } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * `{path: Stats}` for the given files, one directory listing per parent
 * directory -- batches many stat calls into one readdir + a stat per
 * matched name, instead of one stat syscall per path. Ported from
 * arr/base.py::scandir_stats; used by the Sonarr adapter's per-series file
 * fetch (linker.ts reuses the same pattern during reconcile).
 *
 * Uses the native (platform) path module, not a forced-POSIX one: the
 * paths here come from the *arr APIs and always describe the production
 * Linux container's filesystem, where native `path` already behaves as
 * POSIX -- this is not the path-jail security boundary in core/template.ts,
 * where forcing POSIX semantics regardless of host is load-bearing.
 */
export function scandirStats(paths: string[]): Map<string, Stats> {
  const byDir = new Map<string, Set<string>>()
  for (const p of paths) {
    const dir = dirname(p) || '/'
    const want = byDir.get(dir) ?? new Set<string>()
    want.add(basename(p))
    byDir.set(dir, want)
  }
  const out = new Map<string, Stats>()
  for (const [dir, want] of byDir) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!want.has(name)) continue
      try {
        out.set(join(dir, name), statSync(join(dir, name)))
      } catch {
        // vanished between readdir and stat -- skip
      }
    }
  }
  return out
}
