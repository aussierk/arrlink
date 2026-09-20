import 'dotenv/config'
import { z } from 'zod'
import { join } from 'node:path'
import { hashPassword } from '../auth/passwords.js'

// Cross-filesystem fallback modes for the hardlinker (core/fsutil.ts).
export const FS_FALLBACK_MODES = ['skip', 'copy', 'symlink'] as const
export type FsFallbackMode = (typeof FS_FALLBACK_MODES)[number]

/** Coerce a raw fs-fallback value (env or Setting) to a valid mode. */
export function normalizeFsFallback(
  value: string | null | undefined,
  fallback: FsFallbackMode = 'skip',
): FsFallbackMode {
  const v = (value ?? '').trim().toLowerCase()
  return (FS_FALLBACK_MODES as readonly string[]).includes(v)
    ? (v as FsFallbackMode)
    : fallback
}

const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => v === '1' || v?.toLowerCase() === 'true')

const EnvSchema = z.object({
  CONFIG_DIR: z.string().default('config'),
  LOG_LEVEL: z.string().default('info'),
  FS_FALLBACK: z.string().default('skip'),

  // Auth: password and OIDC login are independent -- either, both, or
  // neither may be enabled at once (see effectiveAuth() in runtime.ts).
  AUTH_PASSWORD_ENABLED: boolFromEnv,
  AUTH_OIDC_ENABLED: boolFromEnv,
  OIDC_AUTO_LOGIN: z
    .string()
    .optional()
    .transform((v) => v === undefined || v === '1' || v.toLowerCase() === 'true'),
  UI_USERNAME: z.string().default('admin'),
  UI_PASSWORD: z.string().optional(),
  OIDC_ISSUER: z.string().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  SESSION_TTL_H: z.coerce.number().int().default(12),
  // The deployment's external base URL, e.g. "https://arrlink.example.com".
  // See runtime.ts::effectiveAppUrl / api/auth.ts's redirectUri().
  APP_URL: z.string().optional(),
  // Comma-separated hostnames this app is allowed to think it's being
  // reached as.
  TRUSTED_HOSTS: z.string().optional(),
  ENABLE_DEV_CORS: boolFromEnv,
  BACKUP_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === undefined || v === '1' || v.toLowerCase() === 'true'),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().default(7),
  // Display-only in Settings > General -- entrypoint.sh reads $PORT itself
  // before this process starts, so changing this has no live effect.
  PORT: z.coerce.number().int().default(8270),
  LOG_SIZE_LIMIT_MB: z.coerce.number().int().default(10),
})

export interface Settings {
  configDir: string
  logLevel: string
  fsFallback: string
  authPasswordEnabled: boolean
  authOidcEnabled: boolean
  oidcAutoLogin: boolean
  uiUsername: string
  uiPassword: string | undefined
  /** ui_password, hashed once at startup (real Argon2id cost). "" when unset. */
  uiPasswordHash: string
  oidcIssuer: string | undefined
  oidcClientId: string | undefined
  oidcClientSecret: string | undefined
  sessionTtlH: number
  appUrl: string | undefined
  trustedHosts: string | undefined
  enableDevCors: boolean
  backupEnabled: boolean
  backupRetentionDays: number
  port: number
  logSizeLimitMb: number
  dbPath: string
  backupDir: string
  logDir: string
  logPath: string
}

/** Loads and validates env vars, then hashes UI_PASSWORD once up front.
 * Call once at boot, not per-request. */
export async function loadSettings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Settings> {
  const e = EnvSchema.parse(env)
  const uiPasswordHash = e.UI_PASSWORD ? await hashPassword(e.UI_PASSWORD) : ''

  return {
    configDir: e.CONFIG_DIR,
    logLevel: e.LOG_LEVEL,
    fsFallback: e.FS_FALLBACK,
    authPasswordEnabled: e.AUTH_PASSWORD_ENABLED,
    authOidcEnabled: e.AUTH_OIDC_ENABLED,
    oidcAutoLogin: e.OIDC_AUTO_LOGIN,
    uiUsername: e.UI_USERNAME,
    uiPassword: e.UI_PASSWORD,
    uiPasswordHash,
    oidcIssuer: e.OIDC_ISSUER,
    oidcClientId: e.OIDC_CLIENT_ID,
    oidcClientSecret: e.OIDC_CLIENT_SECRET,
    sessionTtlH: e.SESSION_TTL_H,
    appUrl: e.APP_URL,
    trustedHosts: e.TRUSTED_HOSTS,
    enableDevCors: e.ENABLE_DEV_CORS,
    backupEnabled: e.BACKUP_ENABLED,
    backupRetentionDays: e.BACKUP_RETENTION_DAYS,
    port: e.PORT,
    logSizeLimitMb: e.LOG_SIZE_LIMIT_MB,
    dbPath: join(e.CONFIG_DIR, 'arrlink.db'),
    backupDir: join(e.CONFIG_DIR, 'backups'),
    logDir: join(e.CONFIG_DIR, 'logs'),
    logPath: join(e.CONFIG_DIR, 'logs', 'arrlink.log'),
  }
}
