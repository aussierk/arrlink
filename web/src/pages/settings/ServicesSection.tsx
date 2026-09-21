import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Download, Pencil, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react'
import AppModal from '../../components/AppModal'
import Button from '../../components/ui/Button'
import PageHeader from '../../components/ui/PageHeader'
import { Table, TableEmpty, Th, Thead } from '../../components/ui/Table'
import { api, fmtTime, type AppItem } from '../../lib/api'
import { useAsyncLoad } from '../../lib/useAsyncLoad'
import { useConfirm } from '../../lib/useConfirm'
import { useToast } from '../../lib/useToast'

/**
 * Connect Radarr and Sonarr — test the connection, import tags, and rescan
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
      toast.error(String(e))
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
