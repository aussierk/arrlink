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
 * A 401 means the local session is gone. Send the browser to the dedicated
 * /login route (preserving the current path as `next` so it can return
 * here once signed in) instead of hardcoding one auth path here — /login
 * itself decides between auto-redirecting to OIDC, showing the password
 * form, or both. Redirects at most once to avoid loops.
 */
export function redirectToLogin() {
  if (redirecting) return
  redirecting = true
  const next = window.location.pathname + window.location.search
  window.location.assign(`/login?next=${encodeURIComponent(next)}`)
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
  // Password and OIDC login are independent — either, both, or neither may
  // be enabled at once; the login page offers whichever are active.
  password_enabled: boolean
  oidc_enabled: boolean
  // oidc only: whether /login auto-redirects to the provider on load
  auto_login: boolean
  email?: string | null
  name?: string | null
}

export type AuthConfig = {
  password_enabled: boolean
  oidc_enabled: boolean
  auto_login: boolean
  ui_username: string
  ui_password_set: boolean
  oidc_issuer: string
  oidc_client_id: string
  oidc_client_secret_set: boolean
  oidc_redirect_uri: string
}

export type AuthConfigInput = {
  password_enabled: boolean
  oidc_enabled: boolean
  auto_login?: boolean
  // blank = keep the current value (not a secret, but same convention —
  // defaults to "admin" if never set at all)
  ui_username?: string
  // blank = keep the current value (the UI can't recover secrets)
  ui_password?: string
  oidc_issuer?: string
  oidc_client_id?: string
  oidc_client_secret?: string
  oidc_redirect_uri?: string | null
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
  // Manually classified category (Tags page), or null = unclassified. A
  // classified tag counts as a known vocabulary member for its category.
  category: ConditionCategory | null
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

export type ConditionCategory =
  | 'user' | 'genre' | 'language' | 'quality' | 'certification' | 'collection' | 'custom'

// The 5 categories with a real Radarr/Sonarr metadata equivalent and a
// DB-backed vocabulary — the other two (user/custom) are purely tag-based,
// unrestricted, and never offer "source: native" or "match_type: vocabulary".
export const RICH_CATEGORIES: ConditionCategory[] = [
  'genre', 'language', 'quality', 'certification', 'collection',
]

export type ConditionSource = 'tag' | 'native'

export type ConditionItem = {
  category: ConditionCategory
  match_type: 'exact' | 'list' | 'regex' | 'vocabulary'
  match_value: string
  join: 'AND' | 'OR' | null
  // undefined/null == 'tag' (today's only behavior). 'native' matches the
  // item's real Radarr/Sonarr metadata instead of its arbitrary tags — only
  // meaningful for RICH_CATEGORIES.
  source?: ConditionSource | null
}

export type VocabularyEntry = {
  value: string
  source: 'tmdb' | 'trash' | 'instance' | 'observed'
  external_id: string | null
  app_id: number | null
}

export type RuleItem = {
  id: number
  name: string
  app_scope: number | null
  // "All Radarr" / "All Sonarr" — applies to every app of this type instead
  // of one specific instance. Mutually exclusive with app_scope.
  app_type_scope: 'radarr' | 'sonarr' | null
  app_name: string | null
  conditions: ConditionItem[]
  dir_template: string
  filename_template: string | null
  enabled: boolean
  unlink_on_mismatch: boolean
  priority: number
  // Present on create/update responses only (not on list/get) — soft,
  // non-blocking "this value isn't a known vocabulary member" notices.
  vocabulary_warnings?: string[]
}

export type RuleInput = {
  name: string
  app_scope: number | null
  app_type_scope: 'radarr' | 'sonarr' | null
  conditions: ConditionItem[]
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
  category: ConditionCategory
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
  /** Password login: true on success (a session cookie is now set), false on
   * a wrong username/password. Manual fetch (not `req`) — a 401 here is an
   * expected, inline-displayable outcome, not the "session is gone" case
   * `req` handles. */
  loginWithPassword: async (username: string, password: string): Promise<boolean> => {
    const res = await fetch('/api/auth/password', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    return res.ok || res.type === 'opaqueredirect'
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
  setTagCategory: (appId: number, tagId: number, category: ConditionCategory | null) =>
    req<TagItem>(`/api/apps/${appId}/tags/${tagId}/category`, {
      method: 'PATCH',
      body: JSON.stringify({ category }),
    }),

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
  previewRule: (b: RuleInput, appId: number, opts?: { live?: boolean }) =>
    req<{
      app_id: number
      app_name: string
      source: 'snapshot' | 'live'
      snapshot_at: number | null
      total: number
      sample: { item_title: string; src_path: string; dst_path: string }[]
      errors: { item_title: string; src_path: string; error: string }[]
    }>(
      `/api/rules/preview?app_id=${appId}${opts?.live ? '&live=true' : ''}`,
      {
        method: 'POST',
        body: JSON.stringify(b),
      },
    ),
  createRule: (b: RuleInput) =>
    req<RuleItem>('/api/rules', { method: 'POST', body: JSON.stringify(b) }),
  updateRule: (id: number, b: RuleInput) =>
    req<RuleItem>(`/api/rules/${id}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteRule: (id: number) => req<void>(`/api/rules/${id}`, { method: 'DELETE' }),
  checkRuleVocabulary: (b: RuleInput) =>
    req<{ warnings: string[] }>('/api/rules/vocabulary-check', {
      method: 'POST',
      body: JSON.stringify(b),
    }),

  // Vocabulary: known values per condition category, refreshed automatically
  // in the background (see Settings > Vocabulary for status + overrides).
  getVocabulary: (category: ConditionCategory, appType: string, appId?: number | null) =>
    req<VocabularyEntry[]>(
      `/api/vocabulary?category=${category}&app_type=${appType}${
        appId != null ? `&app_id=${appId}` : ''
      }`,
    ),
  syncAppVocabulary: (appId: number) =>
    req<{ ok: boolean }>(`/api/apps/${appId}/vocabulary/sync`, { method: 'POST' }),
  importTmdbVocabulary: () =>
    req<{ imported: Record<string, number> }>('/api/vocabulary/import/tmdb', { method: 'POST' }),
  importTrashVocabulary: (appType: string) =>
    req<{ imported: number }>(`/api/vocabulary/import/trash?app_type=${appType}`, { method: 'POST' }),
  getTmdbSettings: () =>
    req<{ api_key_set: boolean; default_key_configured: boolean }>('/api/settings/tmdb'),
  putTmdbSettings: (apiKey: string) =>
    req<{ api_key_set: boolean; default_key_configured: boolean }>('/api/settings/tmdb', {
      method: 'PUT',
      body: JSON.stringify({ api_key: apiKey }),
    }),
  listLogs: (level?: string) =>
    req<LogEntry[]>(`/api/logs${level ? `?level=${encodeURIComponent(level)}` : ''}`),
  getSettings: () => req<Record<string, unknown>>('/api/settings'),
  getEffectiveSettings: () => req<EffectiveSettings>('/api/settings/effective'),
  getAuthSettings: () => req<AuthConfig>('/api/settings/auth'),
  updateAuthSettings: (b: AuthConfigInput) =>
    req<AuthConfig>('/api/settings/auth', {
      method: 'PUT',
      body: JSON.stringify(b),
    }),
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
  listLinks: (f?: {
    app_id?: number
    rule_id?: number
    status?: string
    limit?: number
    offset?: number
  }) => {
    const p = new URLSearchParams()
    if (f?.app_id) p.set('app_id', String(f.app_id))
    if (f?.rule_id) p.set('rule_id', String(f.rule_id))
    if (f?.status) p.set('status', f.status)
    if (f?.limit != null) p.set('limit', String(f.limit))
    if (f?.offset != null) p.set('offset', String(f.offset))
    const q = p.toString()
    return req<{
      items: LinkItem[]
      total: number
      limit: number
      offset: number
    }>(`/api/links${q ? `?${q}` : ''}`)
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
