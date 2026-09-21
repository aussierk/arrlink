import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Settings } from '../config/env.js'
import {
  effectiveAppUrl,
  effectiveAuth,
  effectiveLoggingSettings,
} from '../config/runtime.js'
import type { DbClient } from '../db/client.js'
import { logEvent } from '../db/events.js'
import type { SettingsStore } from '../db/settings-store.js'
import type { SettingKey } from '../db/kv-types.js'
import * as lockout from '../auth/lockout.js'
import { hashPassword } from '../auth/passwords.js'
import { resolveFsFallback } from '../core/fsutil.js'
import { DEFAULT_ROOTS } from '../core/template.js'
import { FS_FALLBACK_MODES } from '../config/env.js'
import { HttpError } from '../http-error.js'
import { getCurrentUser } from './auth.js'

/** Runtime settings: a JSON key/value store in SQLite. Ported from
 * api/settings.py. Wire format is snake_case, matching web/ and Python. */

export interface SettingsRouteOptions {
  db: DbClient
  settingsStore: SettingsStore
  env: Settings
}

const KEY_RE = /^[a-z0-9_.-]{1,64}$/

// Owned by a dedicated endpoint (PUT /auth, PUT /tmdb) with its own hashing/
// validation/audit-log -- the generic PUT/DELETE /{key} must never touch these.
const PROTECTED_SETTING_KEYS = new Set<SettingKey>([
  'auth_password',
  'auth_password_enabled',
  'auth_oidc_enabled',
  'oidc_auto_login',
  'auth_username',
  'oidc_issuer',
  'oidc_client_id',
  'oidc_client_secret',
  'tmdb_api_key',
  'log_level',
  'log_size_limit_mb',
])

const AuthSettingsSchema = z.object({
  password_enabled: z.boolean().default(false),
  oidc_enabled: z.boolean().default(false),
  auto_login: z.boolean().default(true),
  ui_username: z.string().default(''),
  ui_password: z.string().default(''),
  oidc_issuer: z.string().default(''),
  oidc_client_id: z.string().default(''),
  oidc_client_secret: z.string().default(''),
})

const TmdbSettingsSchema = z.object({ api_key: z.string().default('') })

const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warning', 'error'])
const LOG_SIZE_MB_MIN = 1
const LOG_SIZE_MB_MAX = 1000

const LoggingSettingsSchema = z.object({
  log_level: z.string(),
  log_size_limit_mb: z.number().int(),
})

const SettingValueSchema = z.object({ value: z.unknown() })

function authView(
  db: DbClient,
  settingsStore: SettingsStore,
  env: Settings,
): Record<string, unknown> {
  const auth = effectiveAuth(settingsStore, env)
  const st = lockout.status(db, (auth.uiUsername || 'admin').trim().toLowerCase())
  return {
    password_enabled: auth.passwordEnabled,
    oidc_enabled: auth.oidcEnabled,
    auto_login: Boolean(auth.autoLogin),
    ui_username: auth.uiUsername,
    ui_password_set: Boolean(auth.uiPassword),
    password_locked: st.locked,
    password_locked_until: st.lockedUntil,
    oidc_issuer: auth.oidcIssuer || '',
    oidc_client_id: auth.oidcClientId || '',
    oidc_client_secret_set: Boolean(auth.oidcClientSecret),
  }
}

export function registerSettingsRoutes(
  app: FastifyInstance,
  opts: SettingsRouteOptions,
): void {
  const { db, settingsStore, env } = opts

  app.get('/api/settings', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    return settingsStore.allSettings()
  })

  app.get('/api/settings/effective', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    return {
      global_unlink_on_mismatch: Boolean(
        settingsStore.getSetting('global_unlink_on_mismatch', true),
      ),
      fs_fallback: resolveFsFallback(
        settingsStore,
        env.fsFallback as (typeof FS_FALLBACK_MODES)[number],
      ),
      fs_fallback_modes: [...FS_FALLBACK_MODES],
      allowed_roots: settingsStore.getSetting<string[]>('allowed_roots') ?? [
        ...DEFAULT_ROOTS,
      ],
      app_title: settingsStore.getSetting<string>('app_title') || 'ArrLink',
      app_url: effectiveAppUrl(settingsStore, env),
      display_language: settingsStore.getSetting<string>('display_language') || 'en',
      display_timezone: settingsStore.getSetting<string>('display_timezone') || 'UTC',
      bind_address: '0.0.0.0',
      port: env.port,
    }
  })

  app.get('/api/settings/auth', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    return authView(db, settingsStore, env)
  })

  app.put('/api/settings/auth', async (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const parsed = AuthSettingsSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    const body = parsed.data

    // Validate against the post-save values so we never lock everyone out.
    const effPw =
      body.ui_password ||
      settingsStore.getSetting<string>('auth_password') ||
      env.uiPasswordHash ||
      ''
    const effIssuer =
      body.oidc_issuer ||
      settingsStore.getSetting<string>('oidc_issuer') ||
      env.oidcIssuer ||
      ''
    const effCid =
      body.oidc_client_id ||
      settingsStore.getSetting<string>('oidc_client_id') ||
      env.oidcClientId ||
      ''
    if (body.password_enabled && !effPw) {
      throw new HttpError(422, 'a UI password is required to enable password login')
    }
    if (body.oidc_enabled && !(effIssuer && effCid)) {
      throw new HttpError(
        422,
        'OIDC issuer and client ID are required to enable OIDC login',
      )
    }
    settingsStore.setSetting('auth_password_enabled', body.password_enabled)
    settingsStore.setSetting('auth_oidc_enabled', body.oidc_enabled)
    settingsStore.setSetting('oidc_auto_login', body.auto_login)
    if (body.ui_username) settingsStore.setSetting('auth_username', body.ui_username)
    if (body.ui_password)
      settingsStore.setSetting('auth_password', await hashPassword(body.ui_password))
    if (body.oidc_issuer) settingsStore.setSetting('oidc_issuer', body.oidc_issuer)
    if (body.oidc_client_id)
      settingsStore.setSetting('oidc_client_id', body.oidc_client_id)
    if (body.oidc_client_secret)
      settingsStore.setSetting('oidc_client_secret', body.oidc_client_secret)
    logEvent(
      db,
      'info',
      `auth settings updated (password=${body.password_enabled}, oidc=${body.oidc_enabled})`,
    )
    return authView(db, settingsStore, env)
  })

  app.get('/api/settings/tmdb', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    return {
      api_key_set: Boolean(
        (settingsStore.getSetting<string>('tmdb_api_key') || '').trim(),
      ),
      default_key_configured: Boolean(process.env.TMDB_API_KEY),
    }
  })

  app.put('/api/settings/tmdb', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const parsed = TmdbSettingsSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    if (parsed.data.api_key) settingsStore.setSetting('tmdb_api_key', parsed.data.api_key)
    return {
      api_key_set: Boolean(
        (settingsStore.getSetting<string>('tmdb_api_key') || '').trim(),
      ),
      default_key_configured: Boolean(process.env.TMDB_API_KEY),
    }
  })

  app.get('/api/settings/logging', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const { level, sizeMb } = effectiveLoggingSettings(settingsStore, env)
    return { log_level: level, log_size_limit_mb: sizeMb }
  })

  app.put('/api/settings/logging', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const parsed = LoggingSettingsSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    const level = parsed.data.log_level.toLowerCase()
    if (!VALID_LOG_LEVELS.has(level)) {
      throw new HttpError(
        422,
        `log_level must be one of ${[...VALID_LOG_LEVELS].sort().join(', ')}`,
      )
    }
    if (
      parsed.data.log_size_limit_mb < LOG_SIZE_MB_MIN ||
      parsed.data.log_size_limit_mb > LOG_SIZE_MB_MAX
    ) {
      throw new HttpError(
        422,
        `log_size_limit_mb must be between ${LOG_SIZE_MB_MIN} and ${LOG_SIZE_MB_MAX}`,
      )
    }
    settingsStore.setSetting('log_level', level)
    settingsStore.setSetting('log_size_limit_mb', parsed.data.log_size_limit_mb)
    // Live-apply lands with the pino wiring; only persists for now.
    logEvent(
      db,
      'info',
      `logging settings updated (level=${level}, size_mb=${parsed.data.log_size_limit_mb})`,
    )
    return { log_level: level, log_size_limit_mb: parsed.data.log_size_limit_mb }
  })

  app.put('/api/settings/:key', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const key = (request.params as { key: string }).key
    if (!KEY_RE.test(key)) throw new HttpError(422, 'invalid setting key')
    if (PROTECTED_SETTING_KEYS.has(key as SettingKey)) {
      throw new HttpError(
        403,
        `'${key}' must be changed via its dedicated settings endpoint`,
      )
    }
    const parsed = SettingValueSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    try {
      JSON.stringify(parsed.data.value)
    } catch {
      throw new HttpError(422, 'value must be JSON-serializable')
    }
    settingsStore.setSetting(key as SettingKey, parsed.data.value)
    logEvent(db, 'info', `setting updated: ${key}`)
    return settingsStore.allSettings()
  })

  app.delete('/api/settings/:key', (request, reply) => {
    getCurrentUser(request, db, settingsStore, env)
    const key = (request.params as { key: string }).key
    if (PROTECTED_SETTING_KEYS.has(key as SettingKey)) {
      throw new HttpError(
        403,
        `'${key}' must be changed via its dedicated settings endpoint`,
      )
    }
    settingsStore.deleteSetting(key as SettingKey)
    logEvent(db, 'info', `setting deleted: ${key}`)
    reply.code(204).send()
  })
}
