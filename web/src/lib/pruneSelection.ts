/** Drops ids from `selected` that aren't in `stillVisible`. Returns
 * `selected` unchanged (same reference) when nothing needs dropping, so
 * callers can use it directly as a setState updater. */
export function pruneSelection<T>(selected: Set<T>, stillVisible: Set<T>): Set<T> {
  let changed = false
  const next = new Set<T>()
  for (const id of selected) {
    if (stillVisible.has(id)) next.add(id)
    else changed = true
  }
  return changed ? next : selected
}
