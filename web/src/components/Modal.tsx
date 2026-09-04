import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Minimal modal dialog. Renders a centered panel over a dimmed backdrop and
 * closes on backdrop click or Escape.
 */
export default function Modal({
  title,
  onClose,
  children,
  size = 'md',
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  size?: 'md' | 'xl'
}) {
  const { t } = useTranslation()
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 pt-16"
      onMouseDown={onClose}
    >
      <div
        className={`w-full rounded-lg border border-line bg-surface shadow-xl ${
          size === 'xl' ? 'max-w-4xl' : 'max-w-2xl'
        }`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          <button
            onClick={onClose}
            className="text-fg-subtle hover:text-fg"
            aria-label={t('modal.close')}
          >
            ✕
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}
