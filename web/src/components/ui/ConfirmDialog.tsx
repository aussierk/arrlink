import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react'
import { useTranslation } from 'react-i18next'
import Button from './Button'

export type ConfirmOptions = {
  title: string
  message: React.ReactNode
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'default' | 'danger'
}

/**
 * A styled replacement for window.confirm(), driven by useConfirm(). Renders
 * nothing unless `open`. Resolves the pending promise via onResolve(true |
 * false) on any dismissal path (button, Escape, click-outside).
 */
export default function ConfirmDialog({
  open,
  options,
  onResolve,
}: {
  open: boolean
  options: ConfirmOptions | null
  onResolve: (ok: boolean) => void
}) {
  const { t } = useTranslation()
  if (!options) return null

  return (
    <Dialog open={open} onClose={() => onResolve(false)} className="relative z-60">
      <div className="fixed inset-0 bg-black/60" aria-hidden="true" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-full max-w-sm rounded-lg border border-line bg-surface p-4 shadow-xl">
          <DialogTitle className="text-sm font-semibold text-fg">
            {options.title}
          </DialogTitle>
          <div className="mt-2 text-sm text-fg-soft">{options.message}</div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onResolve(false)}>
              {options.cancelLabel ?? t('confirm.cancel')}
            </Button>
            <Button
              variant={options.variant === 'danger' ? 'danger' : 'primary'}
              autoFocus
              onClick={() => onResolve(true)}
            >
              {options.confirmLabel ?? t('confirm.confirm')}
            </Button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  )
}
