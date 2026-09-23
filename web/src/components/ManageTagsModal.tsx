import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from './Modal'
import Button from './ui/Button'
import Field from './ui/Field'
import Alert from './ui/Alert'
import TagSelect from './ui/TagSelect'
import { api, errorMessage, type MediaItem } from '../lib/api'

/**
 * Bulk add/remove tags on a set of already-selected media items -- writes
 * back to the live Radarr/Sonarr instance (see api/items.ts), not just
 * ArrLink's own DB. "Add" picks from existing tags (new ones are created on
 * the Tags page); "Remove" only offers tags present on a selected item.
 */
export default function ManageTagsModal({
  appId,
  selectedItems,
  suggestions,
  onClose,
  onApplied,
}: {
  appId: number
  selectedItems: MediaItem[]
  /** Tag labels to suggest for "Add" -- this app's known vocabulary plus the
   * shared repository. */
  suggestions: string[]
  onClose: () => void
  onApplied: (result: { ok: number; failed: number }) => void
}) {
  const { t } = useTranslation()
  const [addTags, setAddTags] = useState<string[]>([])
  const [removeTags, setRemoveTags] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const removableOptions = useMemo(
    () => Array.from(new Set(selectedItems.flatMap((i) => i.tags))).sort(),
    [selectedItems],
  )
  const canSubmit = addTags.length > 0 || removeTags.length > 0

  async function submit() {
    if (!canSubmit) return
    setBusy(true)
    setErr(null)
    try {
      const result = await api.setItemTags(appId, {
        item_ids: selectedItems.map((i) => i.id),
        add: addTags,
        remove: removeTags,
      })
      onApplied(result)
      onClose()
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={t('library.manageTags.title', { count: selectedItems.length })}
      onClose={onClose}
    >
      <div className="space-y-4">
        <Field label={t('library.manageTags.add')}>
          <TagSelect
            placeholder={t('library.manageTags.addPlaceholder')}
            options={suggestions}
            selected={addTags}
            onChange={setAddTags}
          />
        </Field>
        <Field label={t('library.manageTags.remove')}>
          <TagSelect
            placeholder={
              removableOptions.length === 0
                ? t('library.manageTags.nothingToRemove')
                : t('library.manageTags.removePlaceholder')
            }
            options={removableOptions}
            selected={removeTags}
            onChange={setRemoveTags}
          />
        </Field>

        <Alert variant="error">{err}</Alert>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('library.manageTags.cancel')}
          </Button>
          <Button
            type="button"
            onClick={() => void submit()}
            loading={busy}
            disabled={!canSubmit || busy}
          >
            {busy ? t('library.manageTags.applying') : t('library.manageTags.apply')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
