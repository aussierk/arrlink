import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type AppItem } from '../../lib/api'
import { inputCls } from '../../lib/ui'
import Field from '../../components/ui/Field'
import { useToast } from '../../lib/useToast'
import SubSection from '../../components/ui/SubSection'
import Button from '../../components/ui/Button'

/**
 * Metadata providers (genre/certification/quality/language/collection):
 * everything here already refreshes automatically in the background
 * (TMDB genre/certification + TRaSH Guides quality naming on a daily
 * cadence, per-service quality profiles/languages/collections on every
 * poll). This section is status + an optional TMDB key override + "refresh
 * now" buttons for immediate feedback — nothing here is a required setup
 * step.
 */
export default function VocabularySection() {
  const { t } = useTranslation()
  const toast = useToast()
  const [apps, setApps] = useState<AppItem[]>([])
  const [apiKey, setApiKey] = useState('')
  const [apiKeySet, setApiKeySet] = useState(false)
  const [defaultKeyConfigured, setDefaultKeyConfigured] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [a, tmdb] = await Promise.all([api.listApps(), api.getTmdbSettings()])
      setApps(a)
      setApiKey('')
      setApiKeySet(tmdb.api_key_set)
      setDefaultKeyConfigured(tmdb.default_key_configured)
    } catch (e) {
      toast.error(String(e))
    }
  }, [toast])

  useEffect(() => {
    void load()
  }, [load])

  async function saveKey() {
    try {
      await api.putTmdbSettings(apiKey)
      toast.success(t('settingsVocab.keySaved'))
      await load()
    } catch (e) {
      toast.error(String(e))
    }
  }

  async function refreshTmdb() {
    setBusy('tmdb')
    try {
      const r = await api.importTmdbVocabulary()
      toast.success(
        t('settingsVocab.tmdbRefreshed', {
          count: Object.values(r.imported).reduce((a, b) => a + b, 0),
        }),
      )
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(null)
    }
  }

  async function refreshTrash(appType: 'radarr' | 'sonarr') {
    setBusy(`trash-${appType}`)
    try {
      const r = await api.importTrashVocabulary(appType)
      toast.success(t('settingsVocab.trashRefreshed', { count: r.imported, appType }))
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(null)
    }
  }

  async function syncApp(appId: number) {
    setBusy(`app-${appId}`)
    try {
      await api.syncAppVocabulary(appId)
      toast.success(t('settingsVocab.appSynced'))
    } catch (e) {
      toast.error(String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-fg">{t('settingsVocab.title')}</h3>
        <p className="text-xs text-fg-subtle">{t('settingsVocab.subtitle')}</p>
      </div>

      <SubSection
        title={t('settingsVocab.tmdbTitle')}
        header={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refreshTmdb()}
            disabled={busy === 'tmdb'}
          >
            {busy === 'tmdb'
              ? t('settingsVocab.refreshing')
              : t('settingsVocab.refreshNow')}
          </Button>
        }
      >
        <p className="text-xs text-fg-subtle">
          {defaultKeyConfigured
            ? t('settingsVocab.tmdbDefaultConfigured')
            : t('settingsVocab.tmdbNoDefault')}
        </p>
        <Field
          label={
            <>
              {t('settingsVocab.tmdbKeyOverride')}{' '}
              {apiKeySet && (
                <span className="text-fg-faint">{t('settingsVocab.setBlankToKeep')}</span>
              )}
            </>
          }
        >
          <input
            className={inputCls}
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              apiKeySet
                ? t('settingsVocab.keySetPlaceholder')
                : t('settingsVocab.keyUnsetPlaceholder')
            }
            autoComplete="off"
          />
        </Field>
        <div className="flex justify-end">
          <Button size="sm" onClick={() => void saveKey()}>
            {t('settingsVocab.saveKey')}
          </Button>
        </div>
      </SubSection>

      <SubSection title={t('settingsVocab.trashTitle')}>
        <p className="text-xs text-fg-subtle">{t('settingsVocab.trashHint')}</p>
        <div className="flex gap-2">
          {(['radarr', 'sonarr'] as const).map((appType) => (
            <Button
              key={appType}
              variant="secondary"
              size="sm"
              onClick={() => void refreshTrash(appType)}
              disabled={busy === `trash-${appType}`}
            >
              {busy === `trash-${appType}`
                ? t('settingsVocab.refreshing')
                : t('settingsVocab.trashRefreshButton', { appType })}
            </Button>
          ))}
        </div>
      </SubSection>

      <SubSection title={t('settingsVocab.instanceTitle')}>
        <p className="text-xs text-fg-subtle">{t('settingsVocab.instanceHint')}</p>
        <div className="space-y-1">
          {apps.length === 0 && (
            <p className="text-xs text-fg-faint">{t('settingsVocab.noApps')}</p>
          )}
          {apps.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between text-sm text-fg-soft"
            >
              <span>
                {a.name} <span className="text-xs text-fg-subtle">({a.type})</span>
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void syncApp(a.id)}
                disabled={busy === `app-${a.id}`}
              >
                {busy === `app-${a.id}`
                  ? t('settingsVocab.refreshing')
                  : t('settingsVocab.syncNow')}
              </Button>
            </div>
          ))}
        </div>
      </SubSection>
    </div>
  )
}
