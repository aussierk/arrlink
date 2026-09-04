import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { api, setDisplayTimezone, type Me } from './api'

type Status = 'loading' | 'ready' | 'error'

type AuthState = {
  /** null until the first fetch resolves, or if it failed. */
  me: Me | null
  status: Status
  /** Re-fetch /api/auth/me (e.g. right after a password login). */
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

/**
 * One `/api/auth/me` fetch for the whole app. `/api/auth/me` never 401s, so
 * this is safe to mount above the auth gate — it covers both /login and the
 * authed shell. Also the single place the app-wide display timezone is
 * seeded (GeneralSection re-sets it on save). Mount once (see RootLayout).
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null)
  const [status, setStatus] = useState<Status>('loading')

  const refresh = useCallback(async () => {
    try {
      const m = await api.me()
      setMe(m)
      setDisplayTimezone(m.display_timezone)
      setStatus('ready')
    } catch {
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const value = useMemo<AuthState>(() => ({ me, status, refresh }), [me, status, refresh])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}
