import { createBrowserRouter, Navigate } from 'react-router-dom'
import RequireAuth from './components/RequireAuth'
import RootLayout from './components/RootLayout'
import RouteError from './components/RouteError'
import Shell from './Shell'
import LoginPage from './pages/LoginPage'
import Dashboard from './pages/Dashboard'
import Library from './pages/Library'
import Tags from './pages/Tags'
import Rules from './pages/Rules'
import Logs from './pages/Logs'
import Settings from './pages/Settings'
import GeneralSection from './pages/settings/GeneralSection'
import ServicesSection from './pages/settings/ServicesSection'
import AuthenticationSection from './pages/settings/AuthenticationSection'
import VocabularySection from './pages/settings/VocabularySection'
import BackupSection from './pages/settings/BackupSection'

/** Data router (createBrowserRouter/RouterProvider, not <BrowserRouter>) --
 * needed for react-router's useBlocker, which only works with this API (see
 * pages/Tags.tsx's unsaved-changes guard).
 *
 * The pathless RootLayout route wraps everything (including /login) in one
 * <AuthProvider> so the whole app shares a single /api/auth/me fetch, and
 * carries the RouteError boundary for the tree. */
export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    errorElement: <RouteError />,
    children: [
      { path: '/login', element: <LoginPage /> },
      {
        path: '/',
        element: (
          <RequireAuth>
            <Shell />
          </RequireAuth>
        ),
        children: [
          { index: true, element: <Dashboard /> },
          { path: 'apps', element: <Navigate to="/settings/services" replace /> },
          { path: 'library', element: <Library /> },
          { path: 'tags', element: <Tags /> },
          { path: 'rules', element: <Rules /> },
          { path: 'logs', element: <Logs /> },
          {
            path: 'settings',
            element: <Settings />,
            children: [
              { index: true, element: <Navigate to="general" replace /> },
              { path: 'general', element: <GeneralSection /> },
              { path: 'services', element: <ServicesSection /> },
              { path: 'authentication', element: <AuthenticationSection /> },
              { path: 'metadata-providers', element: <VocabularySection /> },
              {
                path: 'vocabulary',
                element: <Navigate to="/settings/metadata-providers" replace />,
              },
              { path: 'backup', element: <BackupSection /> },
            ],
          },
        ],
      },
    ],
  },
])
