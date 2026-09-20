import { readdirSync, statSync, type Stats } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** `{path: Stats}` for the given files, one directory listing per parent dir --
 * batches many stat calls into one readdir + a stat per matched name. Ported
 * from arr/base.py::scandir_stats; linker.ts reuses the same pattern. */
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
