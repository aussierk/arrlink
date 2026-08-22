import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { api, setDisplayTimezone } from '../../lib/api'
import { inputCls } from '../../lib/ui'
import { TMDB_CERTIFICATION_COUNTRIES } from '../../lib/countries'
import i18n from '../../i18n'
import Toggle from '../../components/ui/Toggle'
import Field from '../../components/ui/Field'
import Alert from '../../components/ui/Alert'
import SubSection from '../../components/ui/SubSection'

const LOG_LEVELS = ['debug', 'info', 'warning', 'error']

// Intl.supportedValuesOf landed at runtime well before TS's ES2020 lib (this
// project's target) declared it -- every browser this app supports has it.
type IntlWithSupportedValuesOf = typeof Intl & {
  supportedValuesOf(key: 'timeZone'): string[]
}

/** IANA zone names for the Timezone picker, no library needed -- modern
 * browsers support Intl.supportedValuesOf natively. Falls back to just the
 * current value if the browser predates it (very old browsers only). */
function timezoneOptions(current: string): string[] {
  try {
    const zones = (Intl as IntlWithSupportedValuesOf).supportedValuesOf('timeZone')
    return zones.includes(current) ? zones : [current, ...zones]
  } catch {
    return [current]
  }
}

/**
 * Linking behavior applied by the poller and the repair action — the
 * resolved runtime values, editable here (env values are the seed
 * defaults) — plus application identity, localization, network, and
 * logging settings. One Save button for the whole page, matching every
 * other Settings section's convention.
 */
export default function GeneralSection() {
  const { t } = useTranslation()
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  const [unlink, setUnlink] = useState(true)
  const [fsFallback, setFsFallback] = useState('skip')
  const [fsModes, setFsModes] = useState<string[]>(['skip', 'copy', 'symlink'])
  const [rootsText, setRootsText] = useState('/media')

  const [appTitle, setAppTitle] = useState('ArrLink')
  const [appUrl, setAppUrl] = useState('')

  const [displayLanguage, setDisplayLanguageState] = useState('en')
  const [region, setRegion] = useState('US')
  const [timezone, setTimezone] = useState('UTC')

  const [bindAddress, setBindAddress] = useState('0.0.0.0')
  const [port, setPort] = useState(8270)

  const [logLevel, setLogLevel] = useState('info')
  const [logSizeLimitMb, setLogSizeLimitMb] = useState(10)

  const load = useCallback(async () => {
    try {
      const [eff, settings, logging] = await Promise.all([
        api.getEffectiveSettings(),
        api.getSettings(),
        api.getLoggingSettings(),
      ])
      setUnlink(eff.global_unlink_on_mismatch)
      setFsFallback(eff.fs_fallback)
      setFsModes(eff.fs_fallback_modes)
      setRootsText(eff.allowed_roots.join(', '))
      setAppTitle(eff.app_title)
      setAppUrl(eff.app_url)
      setDisplayLanguageState(eff.display_language)
      setTimezone(eff.display_timezone)
      setBindAddress(eff.bind_address)
      setPort(eff.port)
      setRegion((settings['tmdb_certification_country'] as string | undefined) ?? 'US')
      setLogLevel(logging.log_level)
      setLogSizeLimitMb(logging.log_size_limit_mb)
    } catch (e) {
      setErr(String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function onLanguageChange(lng: string) {
    setDisplayLanguageState(lng)
    void i18n.changeLanguage(lng)
  }

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
      await Promise.all([
        api.setSetting('global_unlink_on_mismatch', unlink),
        api.setSetting('fs_fallback', fsFallback),
        api.setSetting('allowed_roots', roots),
        api.setSetting('app_title', appTitle),
        api.setSetting('app_url', appUrl),
        api.setSetting('display_language', displayLanguage),
        api.setSetting('tmdb_certification_country', region),
        api.setSetting('display_timezone', timezone),
        api.putLoggingSettings({
          log_level: logLevel,
          log_size_limit_mb: logSizeLimitMb,
        }),
      ])
      setDisplayTimezone(timezone)
      setOk(t('settingsGeneral.saved'))
      await load()
    } catch (e) {
      setErr(String(e))
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-zinc-200">
          {t('settingsGeneral.title')}
        </h3>
        <p className="text-xs text-zinc-500">{t('settingsGeneral.subtitle')}</p>
      </div>

      <Alert variant="error">{err}</Alert>
      <Alert variant="success">{ok}</Alert>

      <SubSection title={t('settingsGeneral.applicationSectionTitle')}>
        <Field label={t('settingsGeneral.appTitle')}>
          <input
            className={inputCls}
            value={appTitle}
            onChange={(e) => setAppTitle(e.target.value)}
            placeholder="ArrLink"
          />
        </Field>
        <Field label={t('settingsGeneral.appUrl')}>
          <input
            className={inputCls}
            value={appUrl}
            onChange={(e) => setAppUrl(e.target.value)}
            placeholder={t('settingsGeneral.appUrlPlaceholder')}
          />
        </Field>
      </SubSection>

      <SubSection title={t('settingsGeneral.localizationTitle')}>
        <Field label={t('settingsGeneral.displayLanguage')}>
          <select
            className={inputCls}
            value={displayLanguage}
            onChange={(e) => onLanguageChange(e.target.value)}
          >
            <option value="en">English</option>
          </select>
        </Field>
        <Field label={t('settingsGeneral.region')}>
          <select
            className={inputCls}
            value={region}
            onChange={(e) => setRegion(e.target.value)}
          >
            {TMDB_CERTIFICATION_COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('settingsGeneral.timezone')}>
          <select
            className={inputCls}
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
          >
            {timezoneOptions(timezone).map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </Field>
      </SubSection>

      <SubSection title={t('settingsGeneral.networkTitle')}>
        <Field label={t('settingsGeneral.bindAddress')}>
          <span className="text-zinc-300">{bindAddress}</span>
        </Field>
        <Field label={t('settingsGeneral.port')}>
          <span className="text-zinc-300">{port}</span>
        </Field>
        <p className="text-xs text-zinc-600">{t('settingsGeneral.networkHint')}</p>
      </SubSection>

      <SubSection title={t('settingsGeneral.loggingTitle')}>
        <Field label={t('settingsGeneral.logLevel')}>
          <select
            className={inputCls}
            value={logLevel}
            onChange={(e) => setLogLevel(e.target.value)}
          >
            {LOG_LEVELS.map((lvl) => (
              <option key={lvl} value={lvl}>
                {lvl}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={
            <>
              {t('settingsGeneral.logSizeLimit')}
              <span className="mt-0.5 block text-xs text-zinc-600">
                {t('settingsGeneral.logSizeLimitHint')}
              </span>
            </>
          }
        >
          <input
            className={`${inputCls} max-w-32`}
            type="number"
            min={1}
            max={1000}
            value={logSizeLimitMb}
            onChange={(e) => setLogSizeLimitMb(Number(e.target.value))}
          />
        </Field>
      </SubSection>

      <SubSection title={t('settingsGeneral.linkingTitle')}>
        <Field label={t('settingsGeneral.unlinkLabel')}>
          <Toggle checked={unlink} onChange={setUnlink} />
        </Field>

        <Field label={t('settingsGeneral.fsFallback')}>
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
        </Field>

        <Field
          label={
            <>
              {t('settingsGeneral.allowedRoots')}{' '}
              <span className="text-zinc-600">
                {t('settingsGeneral.allowedRootsHint')}
              </span>
            </>
          }
        >
          <input
            className={inputCls}
            value={rootsText}
            onChange={(e) => setRootsText(e.target.value)}
            placeholder={t('settingsGeneral.allowedRootsPlaceholder')}
          />
        </Field>

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
      </SubSection>

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
