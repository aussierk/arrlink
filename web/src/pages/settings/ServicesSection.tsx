import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Download, Pencil, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react'
import AppModal from '../../components/AppModal'
import Button from '../../components/ui/Button'
import PageHeader from '../../components/ui/PageHeader'
import { Table, TableEmpty, Th, Thead } from '../../components/ui/Table'
import { api, errorMessage, fmtTime, type AppItem } from '../../lib/api'
import { useAsyncLoad } from '../../lib/useAsyncLoad'
import { useConfirm } from '../../lib/useConfirm'
import { useToast } from '../../lib/useToast'

/**
 * Connect Radarr and Sonarr -- test the connection, import tags, and rescan
 * to reconcile links. Each row can be edited, tested, have its tags
 * imported, rescanned, or deleted.
 */
export default function ServicesSection() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const toast = useToast()
  const [apps, setApps] = useState<AppItem[]>([])
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<AppItem | null>(null)
  const [rowMsg, setRowMsg] = useState<Record<number, string>>({})

  const load = useAsyncLoad(async () => {
    setApps(await api.listApps())
  }, [])

  function openNew() {
    setEditing(null)
    setModalOpen(true)
  }

  function openEdit(a: AppItem) {
    setEditing(a)
    setModalOpen(true)
  }

  async function remove(a: AppItem) {
    const ok = await confirm({
      title: t('settingsServices.deleteTitle'),
      message: t('settingsServices.deleteConfirm', { name: a.name }),
      variant: 'danger',
    })
    if (!ok) return
    try {
      await api.deleteApp(a.id)
      toast.success(t('settingsServices.deletedMsg', { name: a.name }))
      await load()
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  /** Runs one row's test/import/rescan action: sets a "…ing" message, awaits the
   * call, then sets the success or (via `failMsg`) failure message. Always
   * reloads the table afterward, whether or not the call threw. */
  async function runRowAction<T>(
    id: number,
    startMsg: string,
    call: () => Promise<T>,
    successMsg: (r: T) => string,
    failMsg: (error: string) => string = (error) =>
      t('settingsServices.failMsg', { error }),
  ) {
    setRowMsg((m) => ({ ...m, [id]: startMsg }))
    try {
      const r = await call()
      setRowMsg((m) => ({ ...m, [id]: successMsg(r) }))
    } catch (ex) {
      setRowMsg((m) => ({ ...m, [id]: failMsg(errorMessage(ex)) }))
    }
    await load()
  }

  async function testRow(id: number) {
    await runRowAction(
      id,
      t('settingsServices.testingMsg'),
      () => api.testAppId(id),
      (r) => t('settingsServices.testOkMsg', { version: r.version }),
    )
  }

  async function importRow(id: number) {
    await runRowAction(
      id,
      t('settingsServices.importingMsg'),
      () => api.importTags(id),
      (r) => t('settingsServices.importedMsg', { count: r.imported }),
    )
  }

  async function rescanRow(id: number) {
    await runRowAction(
      id,
      t('settingsServices.scanningMsg'),
      () => api.rescanApp(id),
      (r) =>
        r.ok ? t('settingsServices.scannedMsg') : t('settingsServices.scanFailedMsg'),
      (error) => t('settingsServices.scanFailedErrMsg', { error }),
    )
  }

  return (
    <div className="space-y-4">
      <PageHeader
        size="md"
        title={t('settingsServices.title')}
        subtitle={t('settingsServices.subtitle')}
        actions={
          <Button onClick={openNew}>
            <Plus className="size-4" />
            {t('settingsServices.addService')}
          </Button>
        }
      />

      <Table>
        <Thead>
          <tr>
            <Th>{t('settingsServices.colName')}</Th>
            <Th>{t('settingsServices.colType')}</Th>
            <Th>{t('settingsServices.colUrl')}</Th>
            <Th>{t('settingsServices.colApiKey')}</Th>
            <Th>{t('settingsServices.colPoll')}</Th>
            <Th>{t('settingsServices.colLastPoll')}</Th>
            <Th>{t('settingsServices.colActions')}</Th>
            <Th />
          </tr>
        </Thead>
        <tbody className="divide-y divide-line">
          {apps.length === 0 && (
            <TableEmpty colSpan={8}>
              <Trans i18nKey="settingsServices.empty">
                No services yet. Click <span className="text-accent">Add service</span>.
              </Trans>
            </TableEmpty>
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
                  <Button
                    variant="accent-ghost"
                    size="sm"
                    onClick={() => void importRow(a.id)}
                  >
                    <Download className="size-3.5" />
                    {t('settingsServices.importTags')}
                  </Button>
                  <Button
                    variant="success-ghost"
                    size="sm"
                    onClick={() => void rescanRow(a.id)}
                  >
                    <RefreshCw className="size-3.5" />
                    {t('settingsServices.rescan')}
                  </Button>
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
                  <Button variant="danger-ghost" size="sm" onClick={() => void remove(a)}>
                    <Trash2 className="size-3.5" />
                    {t('settingsServices.delete')}
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </Table>

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
