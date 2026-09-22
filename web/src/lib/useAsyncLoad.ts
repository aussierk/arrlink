import { useCallback, useEffect, useRef, type DependencyList } from 'react'
import { errorMessage } from './api'
import { useToast } from './useToast'

/** Runs `fn` on mount and whenever `deps` changes, toasting any thrown
 * error. Returns the loader so callers can re-invoke it after a mutation. */
export function useAsyncLoad(fn: () => Promise<void>, deps: DependencyList): () => Promise<void> {
  const toast = useToast()
  const fnRef = useRef(fn)
  useEffect(() => {
    fnRef.current = fn
  })

  // `deps` is a parameter, not a literal array, which the React Compiler
  // lint rules can't statically verify.
  const load = useCallback(async () => {
    try {
      await fnRef.current()
    } catch (e) {
      toast.error(errorMessage(e))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/use-memo
  }, deps)

  useEffect(() => {
    void load()
  }, [load])

  return load
}
