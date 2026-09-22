import { useSyncExternalStore } from 'react'
import { getDisplayTimezone, tzListeners } from './api'

/** Reactive read of the app-wide display timezone (see api.ts's displayTimezone) --
 * for a component that must re-render as soon as GeneralSection saves a new value,
 * rather than only picking it up on its next unrelated render. */
export function useDisplayTimezone(): string {
  return useSyncExternalStore(
    (onChange) => {
      tzListeners.add(onChange)
      return () => tzListeners.delete(onChange)
    },
    () => getDisplayTimezone(),
  )
}
