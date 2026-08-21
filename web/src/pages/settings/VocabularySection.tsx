import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type AppItem } from '../../lib/api'
import { inputCls } from '../../lib/ui'
import Field from '../../components/ui/Field'
import Alert from '../../components/ui/Alert'
import SubSection from '../../components/ui/SubSection'

/**
 * Vocabulary sources (genre/certification/quality/language/collection):
 * everything here already refreshes automatically in the background
 * (TMDB genre/certification + TRaSH Guides quality naming on a daily
 * cadence, per-app quality profiles/languages/collections on every poll).
 * This section is status + an optional TMDB key override + "refresh now"
 * buttons for immediate feedback — nothing here is a required setup step.
 */
export default function VocabularySection() {
  const { t } = useTranslation()
  const [apps, setApps] = useState<AppItem[]>([])
  const [apiKey, setApiKey] = useState('')
  const [apiKeySet, setApiKeySet] = useState(false)
  const [defaultKeyConfigured, setDefaultKeyConfigured] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [a, tmdb] = await Promise.all([api.listApps(), api.getTmdbSettings()])
      setApps(a)
      setApiKey('')
      setApiKeySet(tmdb.api_key_set)
      setDefaultKeyConfigured(tmdb.default_key_configured)
    } catch (e) {
      setErr(String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function saveKey() {
    setErr(null)
    setOk(null)
    try {
      await api.putTmdbSettings(apiKey)
      setOk(t('settingsVocab.keySaved'))
      await load()
    } catch (e) {
      setErr(String(e))
    }
  }

  async function refreshTmdb() {
    setErr(null)
    setOk(null)
    setBusy('tmdb')
    try {
      const r = await api.importTmdbVocabulary()
      setOk(
        t('settingsVocab.tmdbRefreshed', {
          count: Object.values(r.imported).reduce((a, b) => a + b, 0),
        }),
      )
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  async function refreshTrash(appType: 'radarr' | 'sonarr') {
    setErr(null)
    setOk(null)
    setBusy(`trash-${appType}`)
    try {
      const r = await api.importTrashVocabulary(appType)
      setOk(t('settingsVocab.trashRefreshed', { count: r.imported, appType }))
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  async function syncApp(appId: number) {
    setErr(null)
    setOk(null)
    setBusy(`app-${appId}`)
    try {
      await api.syncAppVocabulary(appId)
      setOk(t('settingsVocab.appSynced'))
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">
          {t('settingsVocab.title')}
        </h3>
        <p className="text-xs text-zinc-500">{t('settingsVocab.subtitle')}</p>
      </div>

      <Alert variant="error">{err}</Alert>
      <Alert variant="success">{ok}</Alert>

      <SubSection
        title={t('settingsVocab.tmdbTitle')}
        header={
          <button
            onClick={() => void refreshTmdb()}
            disabled={busy === 'tmdb'}
            className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            {busy === 'tmdb'
              ? t('settingsVocab.refreshing')
              : t('settingsVocab.refreshNow')}
          </button>
        }
      >
        <p className="text-xs text-zinc-500">
          {defaultKeyConfigured
            ? t('settingsVocab.tmdbDefaultConfigured')
            : t('settingsVocab.tmdbNoDefault')}
        </p>
        <Field
          label={
            <>
              {t('settingsVocab.tmdbKeyOverride')}{' '}
              {apiKeySet && (
                <span className="text-zinc-600">{t('settingsVocab.setBlankToKeep')}</span>
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
          <button
            onClick={() => void saveKey()}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
          >
            {t('settingsVocab.saveKey')}
          </button>
        </div>
      </SubSection>

      <SubSection title={t('settingsVocab.trashTitle')}>
        <p className="text-xs text-zinc-500">{t('settingsVocab.trashHint')}</p>
        <div className="flex gap-2">
          {(['radarr', 'sonarr'] as const).map((appType) => (
            <button
              key={appType}
              onClick={() => void refreshTrash(appType)}
              disabled={busy === `trash-${appType}`}
              className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              {busy === `trash-${appType}`
                ? t('settingsVocab.refreshing')
                : t('settingsVocab.trashRefreshButton', { appType })}
            </button>
          ))}
        </div>
      </SubSection>

      <SubSection title={t('settingsVocab.instanceTitle')}>
        <p className="text-xs text-zinc-500">{t('settingsVocab.instanceHint')}</p>
        <div className="space-y-1">
          {apps.length === 0 && (
            <p className="text-xs text-zinc-600">{t('settingsVocab.noApps')}</p>
          )}
          {apps.map((a) => (
            <div
              key={a.id}
              className="flex items-center justify-between text-sm text-zinc-300"
            >
              <span>
                {a.name} <span className="text-xs text-zinc-500">({a.type})</span>
              </span>
              <button
                onClick={() => void syncApp(a.id)}
                disabled={busy === `app-${a.id}`}
                className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              >
                {busy === `app-${a.id}`
                  ? t('settingsVocab.refreshing')
                  : t('settingsVocab.syncNow')}
              </button>
            </div>
          ))}
        </div>
      </SubSection>
    </div>
  )
}
