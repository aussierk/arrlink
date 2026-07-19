export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

let redirecting = false

/**
 * A 401 means the local session is gone. Reload the SPA root so the
 * AuthGate re-runs its mode-aware logic (OIDC round-trip, password prompt,
 * or none-mode pass-through) instead of hardcoding one auth path here.
 * Redirects at most once to avoid loops.
 */
export function redirectToLogin() {
  if (redirecting) return
  redirecting = true
  window.location.assign('/')
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  if (res.status === 401) redirectToLogin()
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = await res.json()
      detail =
        typeof body.detail === 'string'
          ? body.detail
          : JSON.stringify(body.detail ?? body)
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export type Health = {
  status: string
  version: string
  schema_version: number | null
  db: string
}

export type Me = {
  authenticated: boolean
  auth_mode: string
  email?: string | null
  name?: string | null
}

export type AppItem = {
  id: number
  name: string
  type: 'radarr' | 'sonarr'
  url: string
  api_key_masked: string
  enabled: boolean
  poll_interval_s: number
  last_poll_at: number | null
  last_error: string | null
  item_count: number
}

export type AppTestResult = {
  ok: boolean
  name?: string
  version?: string
}

export type TagItem = {
  id: number
  app_id: number
  label: string
  count: number
  rule_count: number
  imported_at: number
}

export type AppInput = {
  name: string
  type: 'radarr' | 'sonarr'
  url: string
  api_key: string
  enabled: boolean
  poll_interval_s: number
}

export type RuleItem = {
  id: number
  name: string
  app_scope: number | null
  app_name: string | null
  match_type: 'exact' | 'list' | 'regex'
  match_value: string
  dir_template: string
  filename_template: string | null
  enabled: boolean
  unlink_on_mismatch: boolean
  priority: number
}

export type RuleInput = {
  name: string
  app_scope: number | null
  match_type: 'exact' | 'list' | 'regex'
  match_value: string
  dir_template: string
  filename_template: string | null
  enabled: boolean
  unlink_on_mismatch: boolean
  priority: number
}

export type LogEntry = {
  id: number
  ts: number
  level: string
  app_id: number | null
  rule_id: number | null
  message: string
}

export const api = {
  health: () => req<Health>('/api/health'),
  me: () => req<Me>('/api/auth/me'),
  logout: async () => {
    await fetch('/api/auth/logout', { method: 'POST' })
    window.location.assign('/')
  },
  listApps: () => req<AppItem[]>('/api/apps'),
  createApp: (b: AppInput) =>
    req<AppItem>('/api/apps', { method: 'POST', body: JSON.stringify(b) }),
  deleteApp: (id: number) => req<void>(`/api/apps/${id}`, { method: 'DELETE' }),
  testApp: (b: AppInput) =>
    req<AppTestResult>('/api/apps/test', {
      method: 'POST',
      body: JSON.stringify(b),
    }),
  testAppId: (id: number) =>
    req<AppTestResult>(`/api/apps/${id}/test`, { method: 'POST' }),
  importTags: (id: number) =>
    req<{ imported: number }>(`/api/apps/${id}/tags/import`, {
      method: 'POST',
    }),
  listTags: (appId: number) => req<TagItem[]>(`/api/apps/${appId}/tags`),

  listRules: () => req<RuleItem[]>('/api/rules'),
  previewRule: (b: RuleInput, appId: number) =>
    req<{
      app_id: number
      app_name: string
      total: number
      sample: { item_title: string; src_path: string; dst_path: string }[]
      errors: { item_title: string; src_path: string; error: string }[]
    }>(`/api/rules/preview?app_id=${appId}`, {
      method: 'POST',
      body: JSON.stringify(b),
    }),
  createRule: (b: RuleInput) =>
    req<RuleItem>('/api/rules', { method: 'POST', body: JSON.stringify(b) }),
  deleteRule: (id: number) => req<void>(`/api/rules/${id}`, { method: 'DELETE' }),
  listLogs: (level?: string) =>
    req<LogEntry[]>(`/api/logs${level ? `?level=${encodeURIComponent(level)}` : ''}`),
  getSettings: () => req<Record<string, unknown>>('/api/settings'),
  setSetting: (key: string, value: unknown) =>
    req<Record<string, unknown>>(`/api/settings/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  deleteSetting: (key: string) =>
    req<void>(`/api/settings/${key}`, { method: 'DELETE' }),
}

export function fmtTime(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString()
}

export type AuthError = {
  kind: 'auth_error'
  value: string
}

export function readAuthErrorCookie(): string | null {
  const m = document.cookie
    .split('; ')
    .find((c) => c.startsWith('arrlink_auth_error='))
  return m ? decodeURIComponent(m.split('=')[1]) : null
}
