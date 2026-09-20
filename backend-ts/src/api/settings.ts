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

/** Runtime settings: a JSON key/value store in SQLite. Ported from api/settings.py. */

export interface SettingsRouteOptions {
  db: DbClient
  settingsStore: SettingsStore
  env: Settings
}

const KEY_RE = /^[a-z0-9_.-]{1,64}$/

// Keys owned by a dedicated endpoint (PUT /auth, PUT /tmdb) with its own
// validation and audit logging. The generic PUT/DELETE /{key} below must
// never touch these directly -- doing so would let any authenticated caller
// write an unhashed/unvalidated auth_password (or flip auth_*_enabled) with
// no log_event trail, bypassing every safeguard put_auth() enforces.
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
  passwordEnabled: z.boolean().default(false),
  oidcEnabled: z.boolean().default(false),
  autoLogin: z.boolean().default(true),
  uiUsername: z.string().default(''),
  uiPassword: z.string().default(''),
  oidcIssuer: z.string().default(''),
  oidcClientId: z.string().default(''),
  oidcClientSecret: z.string().default(''),
})

const TmdbSettingsSchema = z.object({ apiKey: z.string().default('') })

const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warning', 'error'])
const LOG_SIZE_MB_MIN = 1
const LOG_SIZE_MB_MAX = 1000

const LoggingSettingsSchema = z.object({
  logLevel: z.string(),
  logSizeLimitMb: z.number().int(),
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
    passwordEnabled: auth.passwordEnabled,
    oidcEnabled: auth.oidcEnabled,
    autoLogin: Boolean(auth.autoLogin),
    uiUsername: auth.uiUsername,
    uiPasswordSet: Boolean(auth.uiPassword),
    passwordLocked: st.locked,
    passwordLockedUntil: st.lockedUntil,
    oidcIssuer: auth.oidcIssuer || '',
    oidcClientId: auth.oidcClientId || '',
    oidcClientSecretSet: Boolean(auth.oidcClientSecret),
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
      globalUnlinkOnMismatch: Boolean(
        settingsStore.getSetting('global_unlink_on_mismatch', true),
      ),
      fsFallback: resolveFsFallback(
        settingsStore,
        env.fsFallback as (typeof FS_FALLBACK_MODES)[number],
      ),
      fsFallbackModes: [...FS_FALLBACK_MODES],
      allowedRoots: settingsStore.getSetting<string[]>('allowed_roots') ?? [
        ...DEFAULT_ROOTS,
      ],
      appTitle: settingsStore.getSetting<string>('app_title') || 'ArrLink',
      appUrl: effectiveAppUrl(settingsStore, env),
      displayLanguage: settingsStore.getSetting<string>('display_language') || 'en',
      displayTimezone: settingsStore.getSetting<string>('display_timezone') || 'UTC',
      bindAddress: '0.0.0.0',
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

    // Validate against the EFFECTIVE (post-save) values so we never allow
    // saving a flag combination that would immediately lock everyone out.
    // Password and OIDC are independent -- both, one, or neither may be enabled.
    const effPw =
      body.uiPassword ||
      settingsStore.getSetting<string>('auth_password') ||
      env.uiPasswordHash ||
      ''
    const effIssuer =
      body.oidcIssuer ||
      settingsStore.getSetting<string>('oidc_issuer') ||
      env.oidcIssuer ||
      ''
    const effCid =
      body.oidcClientId ||
      settingsStore.getSetting<string>('oidc_client_id') ||
      env.oidcClientId ||
      ''
    if (body.passwordEnabled && !effPw) {
      throw new HttpError(422, 'a UI password is required to enable password login')
    }
    if (body.oidcEnabled && !(effIssuer && effCid)) {
      throw new HttpError(
        422,
        'OIDC issuer and client ID are required to enable OIDC login',
      )
    }
    settingsStore.setSetting('auth_password_enabled', body.passwordEnabled)
    settingsStore.setSetting('auth_oidc_enabled', body.oidcEnabled)
    settingsStore.setSetting('oidc_auto_login', body.autoLogin)
    if (body.uiUsername) settingsStore.setSetting('auth_username', body.uiUsername)
    if (body.uiPassword)
      settingsStore.setSetting('auth_password', await hashPassword(body.uiPassword))
    if (body.oidcIssuer) settingsStore.setSetting('oidc_issuer', body.oidcIssuer)
    if (body.oidcClientId) settingsStore.setSetting('oidc_client_id', body.oidcClientId)
    if (body.oidcClientSecret)
      settingsStore.setSetting('oidc_client_secret', body.oidcClientSecret)
    logEvent(
      db,
      'info',
      `auth settings updated (password=${body.passwordEnabled}, oidc=${body.oidcEnabled})`,
    )
    return authView(db, settingsStore, env)
  })

  app.get('/api/settings/tmdb', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    return {
      apiKeySet: Boolean((settingsStore.getSetting<string>('tmdb_api_key') || '').trim()),
      defaultKeyConfigured: Boolean(process.env.TMDB_API_KEY),
    }
  })

  app.put('/api/settings/tmdb', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const parsed = TmdbSettingsSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    if (parsed.data.apiKey) settingsStore.setSetting('tmdb_api_key', parsed.data.apiKey)
    return {
      apiKeySet: Boolean((settingsStore.getSetting<string>('tmdb_api_key') || '').trim()),
      defaultKeyConfigured: Boolean(process.env.TMDB_API_KEY),
    }
  })

  app.get('/api/settings/logging', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const { level, sizeMb } = effectiveLoggingSettings(settingsStore, env)
    return { logLevel: level, logSizeLimitMb: sizeMb }
  })

  app.put('/api/settings/logging', (request) => {
    getCurrentUser(request, db, settingsStore, env)
    const parsed = LoggingSettingsSchema.safeParse(request.body)
    if (!parsed.success) throw new HttpError(422, 'invalid request body')
    const level = parsed.data.logLevel.toLowerCase()
    if (!VALID_LOG_LEVELS.has(level)) {
      throw new HttpError(
        422,
        `log_level must be one of ${[...VALID_LOG_LEVELS].sort().join(', ')}`,
      )
    }
    if (
      parsed.data.logSizeLimitMb < LOG_SIZE_MB_MIN ||
      parsed.data.logSizeLimitMb > LOG_SIZE_MB_MAX
    ) {
      throw new HttpError(
        422,
        `log_size_limit_mb must be between ${LOG_SIZE_MB_MIN} and ${LOG_SIZE_MB_MAX}`,
      )
    }
    settingsStore.setSetting('log_level', level)
    settingsStore.setSetting('log_size_limit_mb', parsed.data.logSizeLimitMb)
    // Live-apply (reconfiguring the running logger) lands with the pino
    // wiring in app.ts -- not yet in place, so this only persists for now.
    logEvent(
      db,
      'info',
      `logging settings updated (level=${level}, size_mb=${parsed.data.logSizeLimitMb})`,
    )
    return { logLevel: level, logSizeLimitMb: parsed.data.logSizeLimitMb }
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
