import type { SettingsStore } from '../db/settings-store.js'
import type { Settings } from './env.js'

export interface EffectiveAuth {
  passwordEnabled: boolean
  oidcEnabled: boolean
  autoLogin: boolean
  uiUsername: string
  uiPassword: string
  oidcIssuer: string
  oidcClientId: string
  oidcClientSecret: string
  sessionTtlH: number
}

/** Resolves runtime auth config: a DB Setting overrides the env default, but
 * only when explicitly set -- an explicit `false` in the DB must still win
 * over an env default of `true` (use `!== undefined`, not `||`). */
export function effectiveAuth(db: SettingsStore | null, env: Settings): EffectiveAuth {
  const dbPasswordEnabled = db?.getSetting<boolean>('auth_password_enabled')
  const passwordEnabled =
    dbPasswordEnabled !== undefined ? Boolean(dbPasswordEnabled) : env.authPasswordEnabled

  const dbOidcEnabled = db?.getSetting<boolean>('auth_oidc_enabled')
  const oidcEnabled =
    dbOidcEnabled !== undefined ? Boolean(dbOidcEnabled) : env.authOidcEnabled

  const dbAutoLogin = db?.getSetting<boolean>('oidc_auto_login')
  const autoLogin = dbAutoLogin !== undefined ? Boolean(dbAutoLogin) : env.oidcAutoLogin

  return {
    passwordEnabled,
    oidcEnabled,
    autoLogin,
    uiUsername: db?.getSetting<string>('auth_username') || env.uiUsername || 'admin',
    uiPassword: db?.getSetting<string>('auth_password') || env.uiPasswordHash || '',
    oidcIssuer: db?.getSetting<string>('oidc_issuer') || env.oidcIssuer || '',
    oidcClientId: db?.getSetting<string>('oidc_client_id') || env.oidcClientId || '',
    oidcClientSecret:
      db?.getSetting<string>('oidc_client_secret') || env.oidcClientSecret || '',
    sessionTtlH: env.sessionTtlH,
  }
}

/** `app_url`, a runtime Setting overriding the env value -- lets Settings > General
 * edit the external base URL without a redeploy. */
export function effectiveAppUrl(db: SettingsStore | null, env: Settings): string {
  const dbUrl = db?.getSetting<string>('app_url')
  return dbUrl || env.appUrl || ''
}

/** (logLevel, logSizeLimitMb), same DB-overrides-env pattern as effectiveAuth. */
export function effectiveLoggingSettings(
  db: SettingsStore,
  env: Settings,
): { level: string; sizeMb: number } {
  const level = db.getSetting<string>('log_level') || env.logLevel
  const dbSize = db.getSetting<number>('log_size_limit_mb')
  const sizeMb = dbSize !== undefined ? Number(dbSize) : env.logSizeLimitMb
  return { level, sizeMb }
}
