import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fmtTime } from '../lib/api'
import { logLevelClass, useLogStream } from '../lib/useLogStream'
import Button from '../components/ui/Button'
import PageHeader from '../components/ui/PageHeader'
import { Table, TableEmpty, Th, Thead } from '../components/ui/Table'
import { selectCls } from '../lib/ui'

export default function Logs() {
  const { t } = useTranslation()
  const [level, setLevel] = useState('')
  const { logs, error, live, setLive, reload } = useLogStream({ level, cap: 500 })

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('logs.title')}
        subtitle={t('logs.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <select
              className={selectCls}
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
        }
      />

      {error && (
        <div className="rounded-md border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg">
          {error}
        </div>
      )}

      {/* No min-width: only 3 columns, so the message can wrap on a phone
          instead of forcing a horizontal scroll that hides it. */}
      <Table>
        <Thead>
          <tr>
            <Th>{t('logs.colTime')}</Th>
            <Th>{t('logs.colLevel')}</Th>
            <Th>{t('logs.colMessage')}</Th>
          </tr>
        </Thead>
        <tbody className="divide-y divide-line">
          {logs.length === 0 && <TableEmpty colSpan={3}>{t('logs.empty')}</TableEmpty>}
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
      </Table>
    </div>
  )
}
