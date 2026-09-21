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
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  })
  if (res.status === 401) redirectToLogin()
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { detail?: unknown }
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
  // Readable pre-auth (this endpoint never 401s) so the login screen can
  // show the configured title/render times before any session exists.
  app_title: string
  display_timezone: string
  email?: string | null
  name?: string | null
}

export type AuthConfig = {
  password_enabled: boolean
  oidc_enabled: boolean
  auto_login: boolean
  ui_username: string
  ui_password_set: boolean
  password_locked: boolean
  password_locked_until: number | null
  oidc_issuer: string
  oidc_client_id: string
  oidc_client_secret_set: boolean
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
  | 'user'
  | 'genre'
  | 'language'
  | 'audio_language'
  | 'quality'
  | 'certification'
  | 'collection'
  | 'custom'

// The rich categories: a real Radarr/Sonarr metadata equivalent and a
// DB-backed vocabulary — the other two (user/custom) are purely tag-based,
// unrestricted, and never offer "source: native" or "match_type: vocabulary".
// "language" is the title's own production language (movie.originalLanguage /
// series.originalLanguage); "audio_language" is the downloaded file's actual
// audio track(s) (movieFile.languages / episodefile languages) — they can
// differ, e.g. a foreign film with an English dub.
export const RICH_CATEGORIES: ConditionCategory[] = [
  'genre',
  'language',
  'audio_language',
  'quality',
  'certification',
  'collection',
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
  // "source" (default): the item's own source folder name (Radarr/Sonarr's
  // own naming, tmdbid/tvdbid disambiguators included) is always appended
  // under dir_template automatically. "custom": that append is skipped, and
  // dir_template alone must resolve the full destination folder name.
  dir_naming_mode: 'source' | 'custom'
  enabled: boolean
  unlink_on_mismatch: boolean
  priority: number
  // From the list endpoint only (aggregates over `links`): how many links
  // this rule currently owns, and when the most recent one was created.
  link_count: number
  last_link_at: number | null
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
  dir_naming_mode: 'source' | 'custom'
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
  // See ConditionItem.source — presets for a RICH_CATEGORIES category may
  // match native metadata instead of tags (e.g. Genre, Language).
  source?: ConditionSource | null
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
  app_title: string
  app_url: string
  display_language: string
  display_timezone: string
  // Informational only — set at process launch (entrypoint.sh reads $PORT
  // before Python even starts), not editable from here.
  bind_address: string
  port: number
}

export type BackupInfo = {
  name: string
  size: number
  created_at: number
}

export type BackupRunResult =
  { ok: true; path: string; size: number; pruned: number } | { ok: false; error: string }

export type BackupSettings = {
  enabled: boolean
  retention_days: number
  interval_hours: number
}

export type LoggingSettings = {
  log_level: string
  log_size_limit_mb: number
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
  listTagRepository: () => req<{ id: number; label: string }[]>('/api/tags'),
  addTagToRepository: (label: string) =>
    req<{ id: number; label: string }>('/api/tags', {
      method: 'PUT',
      body: JSON.stringify({ label }),
    }),
  deleteTagFromRepository: (label: string) =>
    req<void>(`/api/tags/${encodeURIComponent(label)}`, { method: 'DELETE' }),
  pushTag: (label: string, appIds: number[]) =>
    req<{
      label: string
      ok: number
      failed: number
      results: { app_id: number; ok: boolean; detail: string | null }[]
    }>('/api/tags/push', {
      method: 'POST',
      body: JSON.stringify({ label, app_ids: appIds }),
    }),

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
    }>(`/api/rules/preview?app_id=${appId}${opts?.live ? '&live=true' : ''}`, {
      method: 'POST',
      body: JSON.stringify(b),
    }),
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
    req<{ imported: Record<string, number> }>('/api/vocabulary/import/tmdb', {
      method: 'POST',
    }),
  importTrashVocabulary: (appType: string) =>
    req<{ imported: number }>(`/api/vocabulary/import/trash?app_type=${appType}`, {
      method: 'POST',
    }),
  getTmdbSettings: () =>
    req<{ api_key_set: boolean; default_key_configured: boolean }>('/api/settings/tmdb'),
  putTmdbSettings: (apiKey: string) =>
    req<{ api_key_set: boolean; default_key_configured: boolean }>('/api/settings/tmdb', {
      method: 'PUT',
      body: JSON.stringify({ api_key: apiKey }),
    }),
  listLogs: (level?: string, ruleId?: number) => {
    const p = new URLSearchParams()
    if (level) p.set('level', level)
    if (ruleId != null) p.set('rule_id', String(ruleId))
    const q = p.toString()
    return req<LogEntry[]>(`/api/logs${q ? `?${q}` : ''}`)
  },
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
  deleteSetting: (key: string) => req<void>(`/api/settings/${key}`, { method: 'DELETE' }),

  listBackups: () => req<BackupInfo[]>('/api/backup'),
  runBackup: () => req<BackupRunResult>('/api/backup/run', { method: 'POST' }),
  getBackupSettings: () => req<BackupSettings>('/api/backup/settings'),
  putBackupSettings: (b: BackupSettings) =>
    req<BackupSettings>('/api/backup/settings', {
      method: 'PUT',
      body: JSON.stringify(b),
    }),

  getLoggingSettings: () => req<LoggingSettings>('/api/settings/logging'),
  putLoggingSettings: (b: LoggingSettings) =>
    req<LoggingSettings>('/api/settings/logging', {
      method: 'PUT',
      body: JSON.stringify(b),
    }),

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
  deleteLink: (id: number) => req<void>(`/api/links/${id}`, { method: 'DELETE' }),
  repairLinks: () =>
    req<{ fixed: number; failed: number }>('/api/links/repair', {
      method: 'POST',
    }),
  rescanApp: (id: number) =>
    req<{ ok: boolean }>(`/api/apps/${id}/rescan`, { method: 'POST' }),
  summary: () => req<Summary>('/api/apps/summary'),
}

export type Summary = {
  active_links: number
  stale_links: number
  missing_links: number
  orphaned_rules: string[]
}

// App-wide display timezone (Settings > General > Timezone) — every viewer
// sees the same rendered time regardless of their own browser's local zone.
// Module-level, set once at boot from Me.display_timezone (see Shell.tsx)
// and again immediately whenever GeneralSection saves a new value, mirroring
// the `redirecting` module state above — no context/prop-drilling needed
// since every call site just reads the current value at render time.
let displayTimezone = 'UTC'

export function setDisplayTimezone(tz: string) {
  displayTimezone = tz
}

export function getDisplayTimezone(): string {
  return displayTimezone
}

export function fmtTime(ts: number | null): string {
  if (!ts) return '-'
  return new Date(ts * 1000).toLocaleString(undefined, { timeZone: displayTimezone })
}

/** "3 minutes ago" / "in 2 hours" from a unix-seconds timestamp. Locale-aware
 * via Intl.RelativeTimeFormat; picks the largest sensible unit. */
export function fmtRelative(ts: number | null): string {
  if (!ts) return '-'
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const diff = ts - Date.now() / 1000
  const abs = Math.abs(diff)
  const [unit, secs]: [Intl.RelativeTimeFormatUnit, number] =
    abs < 60
      ? ['second', 1]
      : abs < 3600
        ? ['minute', 60]
        : abs < 86400
          ? ['hour', 3600]
          : ['day', 86400]
  return rtf.format(Math.round(diff / secs), unit)
}

export type AuthError = {
  kind: 'auth_error'
  value: string
}

export function readAuthErrorCookie(): string | null {
  const m = document.cookie.split('; ').find((c) => c.startsWith('arrlink_auth_error='))
  return m ? decodeURIComponent(m.split('=')[1]) : null
}

/**
 * Fire-and-forget: record a frontend exception in the backend event log so
 * it surfaces on the Logs page / live stream. Deliberately not routed
 * through `req()` — a failure here must never trigger the 401 redirect or
 * throw back into whatever error handler called it.
 */
export function reportClientError(input: {
  message: string
  level?: 'error' | 'warn' | 'info'
  url?: string
  stack?: string
}): void {
  void fetch('/api/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
    body: JSON.stringify({
      message: input.message.slice(0, 500),
      level: input.level ?? 'error',
      url: input.url ?? window.location.pathname,
      stack: (input.stack ?? '').slice(0, 2000),
    }),
  }).catch(() => {})
}
