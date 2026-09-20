// Every key read/written in the settings k/v table -- a compile-time typo
// guard, not a schema (the table itself stays a generic key/value store).
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

// Never returned by GET /api/settings -- exposed only via the masked
// GET /api/settings/auth endpoint.
export const SENSITIVE_SETTING_KEYS: ReadonlySet<SettingKey> = new Set([
  'auth_password',
  'oidc_client_secret',
  'tmdb_api_key',
])
