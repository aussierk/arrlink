import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from './Modal'
import Button from './ui/Button'
import Field from './ui/Field'
import Alert from './ui/Alert'
import { api, errorMessage } from '../lib/api'
import { inputCls } from '../lib/ui'
import { useToast } from '../lib/useToast'

/** Creates a tag on one service (Radarr/Sonarr) and adds it to the shared tag list. */
export default function CreateTagModal({
  appId,
  onClose,
  onCreated,
}: {
  appId: number
  onClose: () => void
  onCreated: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const trimmed = label.trim()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!trimmed) return
    setBusy(true)
    setErr(null)
    try {
      await api.addTagToRepository(trimmed)
      const r = await api.pushTag(trimmed, [appId])
      if (r.failed > 0) throw new Error(r.results[0]?.detail ?? 'failed')
      toast.success(t('tags.appTags.created', { label: trimmed }))
      onCreated()
      onClose()
    } catch (ex) {
      setErr(errorMessage(ex))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal title={t('tags.appTags.createTitle')} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <Field label={t('tags.appTags.createLabel')}>
          <input
            className={inputCls}
            autoFocus
            maxLength={100}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('tags.appTags.createPlaceholder')}
          />
          <p className="text-xs text-fg-subtle">{t('tags.appTags.createHint')}</p>
        </Field>
        <Alert variant="error">{err}</Alert>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('tags.appTags.cancel')}
          </Button>
          <Button type="submit" loading={busy} disabled={!trimmed || busy}>
            {busy ? t('tags.appTags.creating') : t('tags.appTags.create')}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
