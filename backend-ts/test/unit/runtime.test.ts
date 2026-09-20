import { describe, expect, it } from 'vitest'
import {
  effectiveAuth,
  effectiveAppUrl,
  effectiveLoggingSettings,
} from '../../src/config/runtime.js'
import type { Settings } from '../../src/config/env.js'
import type { SettingsStore } from '../../src/db/settings-store.js'

function fakeStore(values: Record<string, unknown>): SettingsStore {
  return {
    getSetting: (key: string) => values[key],
  } as unknown as SettingsStore
}

const baseEnv: Settings = {
  configDir: 'config',
  logLevel: 'info',
  fsFallback: 'skip',
  authPasswordEnabled: true,
  authOidcEnabled: true,
  oidcAutoLogin: true,
  uiUsername: 'admin',
  uiPassword: undefined,
  uiPasswordHash: '',
  oidcIssuer: undefined,
  oidcClientId: undefined,
  oidcClientSecret: undefined,
  sessionTtlH: 12,
  appUrl: undefined,
  trustedHosts: undefined,
  forwardedAllowIps: '127.0.0.1',
  enableDevCors: false,
  backupEnabled: true,
  backupRetentionDays: 7,
  port: 8270,
  logSizeLimitMb: 10,
  dbPath: 'config/arrlink.db',
  backupDir: 'config/backups',
  logDir: 'config/logs',
  logPath: 'config/logs/arrlink.log',
}

describe('effectiveAuth boolean override precedence', () => {
  // The four (DB set/unset) x (env true/false) combinations for each
  // boolean override key -- see the plan's risk callout: a naive `||`
  // port silently inverts "explicit false in DB beats env true".
  it('DB unset falls back to env value (true)', () => {
    const result = effectiveAuth(fakeStore({}), { ...baseEnv, authPasswordEnabled: true })
    expect(result.passwordEnabled).toBe(true)
  })

  it('DB unset falls back to env value (false)', () => {
    const result = effectiveAuth(fakeStore({}), {
      ...baseEnv,
      authPasswordEnabled: false,
    })
    expect(result.passwordEnabled).toBe(false)
  })

  it('explicit DB false overrides env true', () => {
    const result = effectiveAuth(fakeStore({ auth_password_enabled: false }), {
      ...baseEnv,
      authPasswordEnabled: true,
    })
    expect(result.passwordEnabled).toBe(false)
  })

  it('explicit DB true overrides env false', () => {
    const result = effectiveAuth(fakeStore({ auth_password_enabled: true }), {
      ...baseEnv,
      authPasswordEnabled: false,
    })
    expect(result.passwordEnabled).toBe(true)
  })

  it('null db (no store) always uses env value', () => {
    const result = effectiveAuth(null, { ...baseEnv, authOidcEnabled: false })
    expect(result.oidcEnabled).toBe(false)
  })

  it('same precedence applies to oidc_auto_login', () => {
    const result = effectiveAuth(fakeStore({ oidc_auto_login: false }), {
      ...baseEnv,
      oidcAutoLogin: true,
    })
    expect(result.autoLogin).toBe(false)
  })
})

describe('effectiveAppUrl', () => {
  it('prefers DB setting over env', () => {
    expect(
      effectiveAppUrl(fakeStore({ app_url: 'https://db.example.com' }), {
        ...baseEnv,
        appUrl: 'https://env.example.com',
      }),
    ).toBe('https://db.example.com')
  })

  it('falls back to env when DB unset', () => {
    expect(
      effectiveAppUrl(fakeStore({}), { ...baseEnv, appUrl: 'https://env.example.com' }),
    ).toBe('https://env.example.com')
  })

  it('falls back to empty string when both unset', () => {
    expect(effectiveAppUrl(fakeStore({}), { ...baseEnv, appUrl: undefined })).toBe('')
  })
})

describe('effectiveLoggingSettings', () => {
  it('DB size override of 0 is honored (not treated as unset)', () => {
    const result = effectiveLoggingSettings(fakeStore({ log_size_limit_mb: 0 }), {
      ...baseEnv,
      logSizeLimitMb: 10,
    })
    expect(result.sizeMb).toBe(0)
  })

  it('falls back to env when DB unset', () => {
    const result = effectiveLoggingSettings(fakeStore({}), {
      ...baseEnv,
      logSizeLimitMb: 25,
    })
    expect(result.sizeMb).toBe(25)
    expect(result.level).toBe('info')
  })
})
