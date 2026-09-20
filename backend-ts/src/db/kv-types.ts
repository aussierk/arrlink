// Every key actually read/written across the Python backend's settings k/v
// table (grep of get_setting/set_setting call sites). This is a compile-time
// typo guard, not a schema -- the settings table itself stays a generic
// key/value store (see db/settings-store.ts and the plan's "Database:
// Drizzle schema" section for why it isn't normalized into columns).
export type SettingKey =
  | 'auth_password_enabled'
  | 'auth_oidc_enabled'
  | 'oidc_auto_login'
  | 'auth_username'
  | 'auth_password'
  | 'oidc_issuer'
  | 'oidc_client_id'
  | 'oidc_client_secret'
  | 'oidc_allowed_emails'
  | 'oidc_allowed_groups'
  | 'app_url'
  | 'fs_fallback'
  | 'allowed_roots'
  | 'app_title'
  | 'display_timezone'
  | 'events_retention'
  | 'global_unlink_on_mismatch'
  | 'log_level'
  | 'log_size_limit_mb'
  | 'tmdb_api_key'
  | 'backup_enabled'
  | 'backup_retention_days'

// Must never be returned by GET /api/settings -- read directly where
// needed and exposed only through the masked GET /api/settings/auth
// endpoint. Ported 1:1 from state.py::State.SENSITIVE_SETTING_KEYS.
export const SENSITIVE_SETTING_KEYS: ReadonlySet<SettingKey> = new Set([
  'auth_password',
  'oidc_client_secret',
  'tmdb_api_key',
])
