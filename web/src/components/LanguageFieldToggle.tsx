import { useTranslation } from 'react-i18next'

const VARIANTS = ['language', 'audio_language'] as const
type LanguageVariant = (typeof VARIANTS)[number]

/**
 * Button-pair toggle for which real field a merged "Language" condition/tag
 * classification targets: the title's own production language, or the
 * downloaded file's actual audio track language. Shared between the rule
 * modal's ConditionRow (per-condition) and the Tags page (per-tag
 * classification) -- see categoryMeta.ts's `mergeGroup`.
 */
export default function LanguageFieldToggle({
  value,
  disabledVariant,
  onChange,
}: {
  value: LanguageVariant
  // A variant to disable (e.g. already used by another condition row) --
  // Tags.tsx has no such collision, so it's omitted there.
  disabledVariant?: LanguageVariant | null
  onChange: (variant: LanguageVariant) => void
}) {
  const { t } = useTranslation()
  return (
    <div>
      <div className="flex gap-1.5">
        {VARIANTS.map((variant) => (
          <button
            key={variant}
            type="button"
            disabled={variant === disabledVariant}
            onClick={() => onChange(variant)}
            className={
              'rounded-md border px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-40 ' +
              (value === variant
                ? 'border-ring bg-accent-bg text-accent'
                : 'border-line-strong text-fg-muted hover:bg-fill')
            }
          >
            {variant === 'language'
              ? t('ruleModal.compareOriginalLanguage')
              : t('ruleModal.compareAudioTrack')}
          </button>
        ))}
      </div>
      <p className="mt-1 text-xs text-fg-subtle">
        {value === 'language'
          ? t('ruleModal.compareOriginalLanguageHint')
          : t('ruleModal.compareAudioTrackHint')}
      </p>
    </div>
  )
}
