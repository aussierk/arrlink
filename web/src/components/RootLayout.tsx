import { Outlet } from 'react-router-dom'
import { AuthProvider } from '../lib/useAuth'

/**
 * Pathless root route element: wraps every route (both /login and the authed
 * shell) in a single <AuthProvider> so they share one /api/auth/me fetch.
 */
export default function RootLayout() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  )
}
