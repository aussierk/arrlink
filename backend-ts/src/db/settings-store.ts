import { eq } from 'drizzle-orm'
import type { DbClient } from './client.js'
import { settings } from './schema.js'
import { SENSITIVE_SETTING_KEYS, type SettingKey } from './kv-types.js'

// Ported 1:1 from state.py's settings section (get_setting/set_setting/
// delete_setting/all_settings). This is a generic runtime-overrides store,
// not a typed config table -- see the plan for why.
export class SettingsStore {
  constructor(private readonly db: DbClient) {}

  getSetting<T = unknown>(key: SettingKey): T | undefined
  getSetting<T = unknown>(key: SettingKey, defaultValue: T): T
  getSetting<T = unknown>(key: SettingKey, defaultValue?: T): T | undefined {
    const row = this.db
      .select({ valueJson: settings.valueJson })
      .from(settings)
      .where(eq(settings.key, key))
      .get()
    return row ? (JSON.parse(row.valueJson) as T) : defaultValue
  }

  setSetting(key: SettingKey, value: unknown): void {
    this.db
      .insert(settings)
      .values({ key, valueJson: JSON.stringify(value) })
      .onConflictDoUpdate({
        target: settings.key,
        set: { valueJson: JSON.stringify(value) },
      })
      .run()
  }

  deleteSetting(key: SettingKey): void {
    this.db.delete(settings).where(eq(settings.key, key)).run()
  }

  allSettings(): Record<string, unknown> {
    const rows = this.db
      .select({ key: settings.key, valueJson: settings.valueJson })
      .from(settings)
      .orderBy(settings.key)
      .all()
    const out: Record<string, unknown> = {}
    for (const row of rows) {
      if (SENSITIVE_SETTING_KEYS.has(row.key as SettingKey)) continue
      out[row.key] = JSON.parse(row.valueJson)
    }
    return out
  }
}
