import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react'
import { useTranslation } from 'react-i18next'

/**
 * Modal dialog. Headless UI's <Dialog> supplies the parts a hand-rolled
 * overlay was missing: focus trap + restore, scroll lock, a portal, and
 * role="dialog" / aria-modal / aria-labelledby. Closes on Escape or a
 * click outside the panel (both via `onClose`).
 *
 * Public API is unchanged — callers still mount/unmount this themselves and
 * pass `title` / `onClose` / `size`.
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

  return (
    <Dialog open onClose={onClose} className="relative z-50">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-black/60 transition duration-150 data-closed:opacity-0 motion-reduce:transition-none"
      />
      <div className="fixed inset-0 flex items-start justify-center overflow-y-auto p-4 pt-6 sm:pt-16">
        <DialogPanel
          transition
          className={`w-full rounded-lg border border-line bg-surface shadow-xl transition duration-150 data-closed:scale-95 data-closed:opacity-0 motion-reduce:transition-none motion-reduce:data-closed:scale-100 ${
            size === 'xl' ? 'max-w-4xl' : 'max-w-2xl'
          }`}
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <DialogTitle className="text-sm font-semibold text-fg">{title}</DialogTitle>
            <button
              onClick={onClose}
              className="rounded text-fg-subtle hover:text-fg focus-visible:focus-ring"
              aria-label={t('modal.close')}
            >
              ✕
            </button>
          </div>
          <div className="p-4">{children}</div>
        </DialogPanel>
      </div>
    </Dialog>
  )
}
