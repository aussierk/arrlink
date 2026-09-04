import { Monitor, Moon, Sun } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useTheme, type Theme } from '../../lib/useTheme'

const OPTIONS: { value: Theme; icon: typeof Sun; labelKey: string }[] = [
  { value: 'light', icon: Sun, labelKey: 'theme.light' },
  { value: 'system', icon: Monitor, labelKey: 'theme.system' },
  { value: 'dark', icon: Moon, labelKey: 'theme.dark' },
]

/** Three-way light / system / dark switch. */
export default function ThemeToggle() {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()
  return (
    <div
      role="radiogroup"
      aria-label={t('theme.label')}
      className="inline-flex gap-0.5 rounded-md border border-line p-0.5"
    >
      {OPTIONS.map(({ value, icon: Icon, labelKey }) => {
        const active = theme === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={t(labelKey)}
            title={t(labelKey)}
            onClick={() => setTheme(value)}
            className={`rounded p-1 transition-colors focus-visible:focus-ring ${
              active ? 'bg-accent-bg text-accent' : 'text-fg-subtle hover:text-fg'
            }`}
          >
            <Icon className="size-3.5" />
          </button>
        )
      })}
    </div>
  )
}
