import { Component, type ErrorInfo, type ReactNode } from 'react'
import i18n from '../i18n'
import { reportClientError } from '../lib/api'
import Button from './ui/Button'

type Props = { children: ReactNode; fallback?: ReactNode }
type State = { error: Error | null }

/**
 * Top-level render-error catch. Without this, an uncaught error anywhere in
 * the tree unmounts the whole app to a blank page. Reports to the backend
 * event log (via componentDidCatch) and shows a recoverable fallback.
 *
 * Route-level (loader/render) errors are handled separately by
 * <RouteError> wired as each route's errorElement; this boundary is the
 * outer net in main.tsx for anything that escapes routing.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientError({
      message: `${error.name}: ${error.message}`,
      stack: `${error.stack ?? ''}\n${info.componentStack ?? ''}`,
    })
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return this.props.fallback ?? <ErrorFallback />
  }
}

export function ErrorFallback() {
  const t = i18n.t
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-8 text-center">
      <div>
        <h1 className="text-lg font-semibold text-fg">{t('errorBoundary.title')}</h1>
        <p className="mt-1 max-w-md text-sm text-fg-subtle">{t('errorBoundary.body')}</p>
      </div>
      <Button onClick={() => window.location.reload()}>
        {t('errorBoundary.reload')}
      </Button>
    </div>
  )
}
