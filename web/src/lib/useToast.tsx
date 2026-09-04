import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, X, XCircle } from 'lucide-react'

type ToastKind = 'success' | 'error'
type Toast = { id: number; kind: ToastKind; message: React.ReactNode }

type ToastApi = {
  success: (message: React.ReactNode) => void
  error: (message: React.ReactNode) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const DISMISS_MS = 5000

/** Renders a bottom-right stack of transient notifications. Mount once (see
 * Shell.tsx). Use for outcomes of an action; keep <Alert> for errors that
 * belong inline next to a form field. */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const remove = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id))
  }, [])

  const push = useCallback((kind: ToastKind, message: React.ReactNode) => {
    const id = nextId.current++
    setToasts((ts) => [...ts, { id, kind, message }])
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push('success', m),
      error: (m) => push('error', m),
    }),
    [push],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-70 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
        role="region"
        aria-label={t('a11y.notifications')}
      >
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={remove} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

/** One notification. Owns its own auto-dismiss timer so it can be paused
 * while the pointer (or keyboard focus) is over it — otherwise a toast can
 * vanish mid-read. */
function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast
  onDismiss: (id: number) => void
}) {
  const { t } = useTranslation()
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    if (paused) return
    const h = setTimeout(() => onDismiss(toast.id), DISMISS_MS)
    return () => clearTimeout(h)
  }, [paused, toast.id, onDismiss])

  return (
    <div
      role={toast.kind === 'error' ? 'alert' : 'status'}
      aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={() => setPaused(false)}
      className={`pointer-events-auto flex items-start gap-2 rounded-md border p-3 text-sm shadow-lg ${
        toast.kind === 'error'
          ? 'border-danger-line bg-danger-bg text-danger-fg'
          : 'border-success-line bg-success-bg text-success-fg'
      }`}
    >
      {toast.kind === 'error' ? (
        <XCircle className="mt-0.5 size-4 shrink-0" />
      ) : (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 wrap-break-word">{toast.message}</span>
      <button
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 rounded text-current/70 hover:text-current focus-visible:focus-ring"
        aria-label={t('a11y.dismiss')}
      >
        <X className="size-4" />
      </button>
    </div>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>')
  return ctx
}
