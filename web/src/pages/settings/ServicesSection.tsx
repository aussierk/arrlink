import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Download, Pencil, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react'
import AppModal from '../../components/AppModal'
import Alert from '../../components/ui/Alert'
import Button from '../../components/ui/Button'
import { api, fmtTime, type AppItem } from '../../lib/api'

/**
 * Connect Radarr and Sonarr — test the connection, import tags, and rescan
 * to reconcile links. Each row can be edited, tested, have its tags
 * imported, rescanned, or deleted.
 */
export default function ServicesSection() {
  const { t } = useTranslation()
  const [apps, setApps] = useState<AppItem[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<AppItem | null>(null)
  const [rowMsg, setRowMsg] = useState<Record<number, string>>({})

  const load = useCallback(async () => {
    try {
      setApps(await api.listApps())
    } catch (e) {
      setErr(String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function openNew() {
    setEditing(null)
    setModalOpen(true)
  }

  function openEdit(a: AppItem) {
    setEditing(a)
    setModalOpen(true)
  }

  async function remove(a: AppItem) {
    if (!confirm(t('settingsServices.deleteConfirm', { name: a.name }))) return
    try {
      await api.deleteApp(a.id)
      setOk(t('settingsServices.deletedMsg', { name: a.name }))
      await load()
    } catch (e) {
      setErr(String(e))
    }
  }

  async function testRow(id: number) {
    setRowMsg((m) => ({ ...m, [id]: t('settingsServices.testingMsg') }))
    try {
      const r = await api.testAppId(id)
      setRowMsg((m) => ({
        ...m,
        [id]: t('settingsServices.testOkMsg', { version: r.version }),
      }))
    } catch (ex) {
      setRowMsg((m) => ({
        ...m,
        [id]: t('settingsServices.failMsg', { error: String(ex) }),
      }))
    }
    await load()
  }

  async function importRow(id: number) {
    setRowMsg((m) => ({ ...m, [id]: t('settingsServices.importingMsg') }))
    try {
      const r = await api.importTags(id)
      setRowMsg((m) => ({
        ...m,
        [id]: t('settingsServices.importedMsg', { count: r.imported }),
      }))
    } catch (ex) {
      setRowMsg((m) => ({
        ...m,
        [id]: t('settingsServices.failMsg', { error: String(ex) }),
      }))
    }
    await load()
  }

  async function rescanRow(id: number) {
    setRowMsg((m) => ({ ...m, [id]: t('settingsServices.scanningMsg') }))
    try {
      const r = await api.rescanApp(id)
      setRowMsg((m) => ({
        ...m,
        [id]: r.ok
          ? t('settingsServices.scannedMsg')
          : t('settingsServices.scanFailedMsg'),
      }))
    } catch (ex) {
      setRowMsg((m) => ({
        ...m,
        [id]: t('settingsServices.scanFailedErrMsg', { error: String(ex) }),
      }))
    }
    await load()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-fg">{t('settingsServices.title')}</h3>
          <p className="text-xs text-fg-subtle">{t('settingsServices.subtitle')}</p>
        </div>
        <Button onClick={openNew}>
          <Plus className="size-4" />
          {t('settingsServices.addService')}
        </Button>
      </div>

      <Alert variant="error">{err}</Alert>
      <Alert variant="success">{ok}</Alert>

      <div className="overflow-hidden rounded-lg border border-line">
        <table className="w-full text-sm">
          <thead className="bg-surface text-left text-xs uppercase tracking-wide text-fg-subtle">
            <tr>
              <th scope="col" className="px-3 py-2">
                {t('settingsServices.colName')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('settingsServices.colType')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('settingsServices.colUrl')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('settingsServices.colApiKey')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('settingsServices.colPoll')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('settingsServices.colLastPoll')}
              </th>
              <th scope="col" className="px-3 py-2">
                {t('settingsServices.colActions')}
              </th>
              <th scope="col" className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {apps.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-fg-subtle">
                  <Trans i18nKey="settingsServices.empty">
                    No services yet — click{' '}
                    <span className="text-accent">Add service</span>.
                  </Trans>
                </td>
              </tr>
            )}
            {apps.map((a) => (
              <tr key={a.id} className="bg-sunken/40">
                <td className="px-3 py-2 font-medium">
                  {a.name}
                  {!a.enabled && (
                    <span className="ml-2 text-xs text-fg-subtle">
                      {t('settingsServices.disabled')}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2">{a.type}</td>
                <td className="px-3 py-2 text-fg-muted">{a.url}</td>
                <td className="px-3 py-2 font-mono text-xs text-fg-subtle">
                  {a.api_key_masked}
                </td>
                <td className="px-3 py-2">
                  {a.poll_interval_s}
                  {t('settingsServices.pollSuffix')}
                </td>
                <td className="px-3 py-2 text-fg-muted">
                  {a.last_error ? (
                    <span className="text-danger-fg">{a.last_error}</span>
                  ) : (
                    fmtTime(a.last_poll_at)
                  )}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => void testRow(a.id)}>
                      <Plug className="size-3.5" />
                      {t('settingsServices.test')}
                    </Button>
                    <button
                      onClick={() => void importRow(a.id)}
                      className="flex items-center gap-1 rounded px-2.5 py-1 text-xs text-accent transition-colors hover:bg-accent-bg focus-visible:focus-ring"
                    >
                      <Download className="size-3.5" />
                      {t('settingsServices.importTags')}
                    </button>
                    <button
                      onClick={() => void rescanRow(a.id)}
                      className="flex items-center gap-1 rounded px-2.5 py-1 text-xs text-success-fg transition-colors hover:bg-success-bg focus-visible:focus-ring"
                    >
                      <RefreshCw className="size-3.5" />
                      {t('settingsServices.rescan')}
                    </button>
                    {rowMsg[a.id] && (
                      <span className="text-xs text-fg-subtle">{rowMsg[a.id]}</span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => openEdit(a)}>
                      <Pencil className="size-3.5" />
                      {t('settingsServices.edit')}
                    </Button>
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      onClick={() => void remove(a)}
                    >
                      <Trash2 className="size-3.5" />
                      {t('settingsServices.delete')}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <AppModal
          initial={editing}
          onClose={() => setModalOpen(false)}
          onSaved={() => void load()}
        />
      )}
    </div>
  )
}
