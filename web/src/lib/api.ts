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

export const DEFAULT_POLL_INTERVAL_S = 300

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

export type LinkItem = {
  id: number
  rule_id: number | null
  rule_name: string | null
  app_id: number | null
  app_name: string | null
  app_type: string | null
  item_id: number | null
  src_path: string
  dst_path: string
  inode: number | null
  status: string
  created_at: number
}

export type LogEntry = {
  id: number
  ts: number
  level: string
  app_id: number | null
  rule_id: number | null
  message: string
}

export type PresetItem = {
  key: string
  name: string
  description: string
  match_type: 'exact' | 'list' | 'regex'
  match_value: string
  subpath: string
  default_base_folder: string
  dir_template: string
}

export type PresetList = {
  app_type: string
  base_folder: string
  presets: PresetItem[]
}

export type EffectiveSettings = {
  global_unlink_on_mismatch: boolean
  fs_fallback: string
  fs_fallback_modes: string[]
  allowed_roots: string[]
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
  updateApp: (id: number, b: AppInput) =>
    req<AppItem>(`/api/apps/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
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

  // Tag repository: a user-curated shared tag list that can be pushed to apps
  listTagRepository: () =>
    req<{ id: number; label: string }[]>('/api/tags'),
  addTagToRepository: (label: string) =>
    req<{ id: number; label: string }>('/api/tags', {
      method: 'PUT',
      body: JSON.stringify({ label }),
    }),
  deleteTagFromRepository: (label: string) =>
    req<void>(`/api/tags/${encodeURIComponent(label)}`, { method: 'DELETE' }),
  pushTag: (label: string, appIds: number[]) =>
    req<{ label: string; ok: number; failed: number; results: { app_id: number; ok: boolean; detail: string | null }[] }>(
      '/api/tags/push',
      { method: 'POST', body: JSON.stringify({ label, app_ids: appIds }) },
    ),

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
  updateRule: (id: number, b: RuleInput) =>
    req<RuleItem>(`/api/rules/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteRule: (id: number) => req<void>(`/api/rules/${id}`, { method: 'DELETE' }),
  listLogs: (level?: string) =>
    req<LogEntry[]>(`/api/logs${level ? `?level=${encodeURIComponent(level)}` : ''}`),
  getSettings: () => req<Record<string, unknown>>('/api/settings'),
  getEffectiveSettings: () => req<EffectiveSettings>('/api/settings/effective'),
  setSetting: (key: string, value: unknown) =>
    req<Record<string, unknown>>(`/api/settings/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    }),
  deleteSetting: (key: string) =>
    req<void>(`/api/settings/${key}`, { method: 'DELETE' }),

  listPresets: (appType: string, baseFolder?: string) =>
    req<PresetList>(
      `/api/presets?app_type=${encodeURIComponent(appType)}${
        baseFolder ? `&base_folder=${encodeURIComponent(baseFolder)}` : ''
      }`,
    ),
  applyPreset: (b: {
    preset_key: string
    app_type: string
    app_scope?: number | null
    base_folder?: string | null
    name?: string | null
  }) =>
    req<{ preset_key: string; rule: RuleItem; message: string }>(
      '/api/presets/apply',
      { method: 'POST', body: JSON.stringify(b) },
    ),
  listLinks: (f?: { app_id?: number; rule_id?: number; status?: string }) => {
    const p = new URLSearchParams()
    if (f?.app_id) p.set('app_id', String(f.app_id))
    if (f?.rule_id) p.set('rule_id', String(f.rule_id))
    if (f?.status) p.set('status', f.status)
    const q = p.toString()
    return req<LinkItem[]>(`/api/links${q ? `?${q}` : ''}`)
  },
  deleteLink: (id: number) =>
    req<void>(`/api/links/${id}`, { method: 'DELETE' }),
  repairLinks: () =>
    req<{ fixed: number; failed: number }>('/api/links/repair', {
      method: 'POST',
    }),
  rescanApp: (id: number) =>
    req<{ ok: boolean }>(`/api/apps/${id}/rescan`, { method: 'POST' }),
  summary: () =>
    req<{
      active_links: number
      stale_links: number
      orphaned_rules: string[]
    }>('/api/apps/summary'),
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
