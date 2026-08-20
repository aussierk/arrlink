import { createBrowserRouter, Navigate } from 'react-router-dom'
import RequireAuth from './components/RequireAuth'
import Shell from './Shell'
import LoginPage from './pages/LoginPage'
import Dashboard from './pages/Dashboard'
import Tags from './pages/Tags'
import Rules from './pages/Rules'
import Logs from './pages/Logs'
import Settings from './pages/Settings'
import GeneralSection from './pages/settings/GeneralSection'
import ServicesSection from './pages/settings/ServicesSection'
import AuthenticationSection from './pages/settings/AuthenticationSection'
import AccessControlSection from './pages/settings/AccessControlSection'
import VocabularySection from './pages/settings/VocabularySection'

/** Data router (createBrowserRouter/RouterProvider, not <BrowserRouter>) --
 * needed for react-router's useBlocker, which only works with this API (see
 * pages/Tags.tsx's unsaved-changes guard). Mirrors the nesting that used to
 * be spread across App.tsx's and Settings.tsx's own inline <Routes>. */
export const router = createBrowserRouter([
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
          { path: 'access', element: <AccessControlSection /> },
          { path: 'vocabulary', element: <VocabularySection /> },
        ],
      },
    ],
  },
])
