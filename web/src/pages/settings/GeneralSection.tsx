import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { api } from '../../lib/api'
import { inputCls } from '../../lib/ui'
import Toggle from '../../components/ui/Toggle'

/**
 * Linking behavior applied by the poller and the repair action — the
 * resolved runtime values, editable here (env values are the seed defaults).
 */
export default function GeneralSection() {
  const { t } = useTranslation()
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  const [unlink, setUnlink] = useState(true)
  const [fsFallback, setFsFallback] = useState('skip')
  const [fsModes, setFsModes] = useState<string[]>(['skip', 'copy', 'symlink'])
  const [rootsText, setRootsText] = useState('/media')

  const load = useCallback(async () => {
    try {
      const eff = await api.getEffectiveSettings()
      setUnlink(eff.global_unlink_on_mismatch)
      setFsFallback(eff.fs_fallback)
      setFsModes(eff.fs_fallback_modes)
      setRootsText(eff.allowed_roots.join(', '))
    } catch (e) {
      setErr(String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function save() {
    setErr(null)
    setOk(null)
    const roots = rootsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (roots.length === 0) {
      setErr(t('settingsGeneral.rootsEmptyErr'))
      return
    }
    try {
      await api.setSetting('global_unlink_on_mismatch', unlink)
      await api.setSetting('fs_fallback', fsFallback)
      await api.setSetting('allowed_roots', roots)
      setOk(t('settingsGeneral.saved'))
      await load()
    } catch (e) {
      setErr(String(e))
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">{t('settingsGeneral.title')}</h3>
        <p className="text-xs text-zinc-500">{t('settingsGeneral.subtitle')}</p>
      </div>

      {err && (
        <div className="rounded-md border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
          {err}
        </div>
      )}
      {ok && (
        <div className="rounded-md border border-emerald-900 bg-emerald-950/40 p-3 text-sm text-emerald-300">
          {ok}
        </div>
      )}

      <Toggle
        checked={unlink}
        onChange={setUnlink}
        label={t('settingsGeneral.unlinkLabel')}
      />

      <div className="flex flex-wrap items-end gap-4">
        <label className="text-sm">
          <span className="mb-1 block text-zinc-400">
            {t('settingsGeneral.fsFallback')}
          </span>
          <select
            className={inputCls}
            value={fsFallback}
            onChange={(e) => setFsFallback(e.target.value)}
          >
            {fsModes.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-64 flex-1 text-sm">
          <span className="mb-1 block text-zinc-400">
            {t('settingsGeneral.allowedRoots')} <span className="text-zinc-600">{t('settingsGeneral.allowedRootsHint')}</span>
          </span>
          <input
            className={inputCls}
            value={rootsText}
            onChange={(e) => setRootsText(e.target.value)}
            placeholder={t('settingsGeneral.allowedRootsPlaceholder')}
          />
        </label>
      </div>
      <p className="text-xs text-zinc-600">
        <Trans
          i18nKey="settingsGeneral.footnote"
          components={[
            <span className="font-mono" key="skip" />,
            <span className="font-mono" key="copy" />,
            <span className="font-mono" key="symlink" />,
          ]}
        />
      </p>
      <div className="flex justify-end">
        <button
          onClick={() => void save()}
          className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
        >
          {t('settingsGeneral.save')}
        </button>
      </div>
    </div>
  )
}
