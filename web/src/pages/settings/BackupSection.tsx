import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCw } from 'lucide-react'
import { api, fmtTime, type BackupInfo } from '../../lib/api'
import { inputCls } from '../../lib/ui'
import Toggle from '../../components/ui/Toggle'
import Field from '../../components/ui/Field'
import Alert from '../../components/ui/Alert'
import SubSection from '../../components/ui/SubSection'
import Button from '../../components/ui/Button'

const DEFAULT_EVENTS_RETENTION = 5000

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(1)} ${units[i]}`
}

/**
 * Manual backup list/trigger for the nightly DB backup job (core/backup.py),
 * plus its enabled/retention settings and the unrelated-but-small "events
 * retention" housekeeping knob — folded in here rather than earning its own
 * nav item, since it's a single field nobody needs to touch often.
 */
export default function BackupSection() {
  const { t } = useTranslation()
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [enabled, setEnabled] = useState(true)
  const [retentionDays, setRetentionDays] = useState(7)
  const [intervalHours, setIntervalHours] = useState(24)
  const [eventsRetention, setEventsRetention] = useState(DEFAULT_EVENTS_RETENTION)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const [list, bset, settings] = await Promise.all([
        api.listBackups(),
        api.getBackupSettings(),
        api.getSettings(),
      ])
      setBackups([...list].sort((a, b) => b.created_at - a.created_at))
      setEnabled(bset.enabled)
      setRetentionDays(bset.retention_days)
      setIntervalHours(bset.interval_hours)
      setEventsRetention(
        (settings['events_retention'] as number | undefined) ?? DEFAULT_EVENTS_RETENTION,
      )
    } catch (e) {
      setErr(String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function runNow() {
    setErr(null)
    setOk(null)
    setRunning(true)
    try {
      const r = await api.runBackup()
      if (r.ok) {
        setOk(t('settingsBackup.runOk', { name: r.path.split('/').pop() ?? r.path }))
        await load()
      } else {
        setErr(t('settingsBackup.runFailed', { error: r.error }))
      }
    } catch (e) {
      setErr(String(e))
    } finally {
      setRunning(false)
    }
  }

  async function saveSettings() {
    setErr(null)
    setOk(null)
    setSaving(true)
    try {
      await api.putBackupSettings({
        enabled,
        retention_days: retentionDays,
        interval_hours: intervalHours,
      })
      await api.setSetting('events_retention', eventsRetention)
      setOk(t('settingsBackup.settingsSaved'))
      await load()
    } catch (e) {
      setErr(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-fg">{t('settingsBackup.title')}</h3>
        <p className="text-xs text-fg-subtle">{t('settingsBackup.subtitle')}</p>
      </div>

      <Alert variant="error">{err}</Alert>
      <Alert variant="success">{ok}</Alert>

      <SubSection
        title={t('settingsBackup.listTitle')}
        header={
          <Button size="sm" onClick={() => void runNow()} disabled={running}>
            <RotateCw className={`size-3.5 ${running ? 'animate-spin' : ''}`} />
            {running ? t('settingsBackup.running') : t('settingsBackup.runNow')}
          </Button>
        }
      >
        {backups.length === 0 ? (
          <p className="text-xs text-fg-faint">{t('settingsBackup.noBackups')}</p>
        ) : (
          <div className="overflow-hidden rounded-md border border-line">
            <table className="w-full text-sm">
              <thead className="bg-surface text-left text-xs uppercase tracking-wide text-fg-subtle">
                <tr>
                  <th scope="col" className="px-3 py-1.5">
                    {t('settingsBackup.colName')}
                  </th>
                  <th scope="col" className="px-3 py-1.5">
                    {t('settingsBackup.colSize')}
                  </th>
                  <th scope="col" className="px-3 py-1.5">
                    {t('settingsBackup.colCreated')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {backups.map((b) => (
                  <tr key={b.name}>
                    <td className="px-3 py-1.5 font-mono text-xs text-fg-soft">
                      {b.name}
                    </td>
                    <td className="px-3 py-1.5 text-fg-muted">{fmtSize(b.size)}</td>
                    <td className="px-3 py-1.5 text-fg-muted">{fmtTime(b.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SubSection>

      <SubSection title={t('settingsBackup.settingsTitle')}>
        <Field label={t('settingsBackup.enabled')}>
          <Toggle checked={enabled} onChange={setEnabled} />
        </Field>
        <Field
          label={
            <>
              {t('settingsBackup.intervalHours')}
              <span className="mt-0.5 block text-xs text-fg-faint">
                {t('settingsBackup.intervalHoursHint')}
              </span>
            </>
          }
        >
          <input
            className={`${inputCls} max-w-32`}
            type="number"
            min={1}
            value={intervalHours}
            onChange={(e) => setIntervalHours(Number(e.target.value))}
          />
        </Field>
        <Field
          label={
            <>
              {t('settingsBackup.retentionDays')}
              <span className="mt-0.5 block text-xs text-fg-faint">
                {t('settingsBackup.retentionDaysHint')}
              </span>
            </>
          }
        >
          <input
            className={`${inputCls} max-w-32`}
            type="number"
            min={1}
            value={retentionDays}
            onChange={(e) => setRetentionDays(Number(e.target.value))}
          />
        </Field>
      </SubSection>

      <SubSection title={t('settingsBackup.housekeepingTitle')}>
        <Field
          label={
            <>
              {t('settingsBackup.eventsRetention')}
              <span className="mt-0.5 block text-xs text-fg-faint">
                {t('settingsBackup.eventsRetentionHint')}
              </span>
            </>
          }
        >
          <input
            className={`${inputCls} max-w-32`}
            type="number"
            min={1}
            value={eventsRetention}
            onChange={(e) => setEventsRetention(Number(e.target.value))}
          />
        </Field>
      </SubSection>

      <div className="flex justify-end">
        <Button onClick={() => void saveSettings()} loading={saving}>
          {saving ? t('settingsBackup.saving') : t('settingsBackup.save')}
        </Button>
      </div>
    </div>
  )
}
