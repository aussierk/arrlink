import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fmtTime } from '../lib/api'
import { logLevelClass, useLogStream } from '../lib/useLogStream'
import Button from '../components/ui/Button'

export default function Logs() {
  const { t } = useTranslation()
  const [level, setLevel] = useState('')
  const { logs, error, live, setLive, reload } = useLogStream({ level, cap: 500 })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="text-xl font-semibold">{t('logs.title')}</h2>
          <p className="text-sm text-fg-subtle">{t('logs.subtitle')}</p>
        </div>
        <select
          className="rounded-md border border-line-strong bg-sunken px-2 py-1.5 text-sm text-fg"
          value={level}
          onChange={(e) => setLevel(e.target.value)}
        >
          <option value="">{t('logs.allLevels')}</option>
          <option value="error">{t('logs.error')}</option>
          <option value="warn">{t('logs.warn')}</option>
          <option value="info">{t('logs.info')}</option>
        </select>
        <Button variant="secondary" onClick={() => void reload()}>
          {t('common.refresh')}
        </Button>
        <label className="flex items-center gap-2 text-sm text-fg-soft">
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
          />
          {t('logs.live')}
        </label>
      </div>

      {error && (
        <div className="rounded-md border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-line">
        {/* No min-width: only 3 columns, so the message can wrap on a phone
            instead of forcing a horizontal scroll that hides it. */}
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-xs uppercase tracking-wide text-fg-subtle">
            <tr>
              <th scope="col" className="px-3 py-2">
                {t('logs.colTime')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('logs.colLevel')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('logs.colMessage')}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {logs.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-6 text-center text-fg-subtle">
                  {t('logs.empty')}
                </td>
              </tr>
            )}
            {logs.map((l) => (
              <tr key={l.id} className="bg-sunken/40">
                <td className="whitespace-nowrap px-3 py-2 text-fg-muted">
                  {fmtTime(l.ts)}
                </td>
                <td className="px-3 py-2">
                  <span className={logLevelClass(l.level)}>{l.level}</span>
                </td>
                <td className="wrap-break-word px-3 py-2 text-fg">{l.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
