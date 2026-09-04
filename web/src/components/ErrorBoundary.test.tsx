import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ErrorBoundary from './ErrorBoundary'

const { reportMock } = vi.hoisted(() => ({
  reportMock: vi.fn<(input: { message: string; stack?: string }) => void>(),
}))
vi.mock('../lib/api', () => ({ reportClientError: reportMock }))

function Boom(): never {
  throw new Error('kaboom')
}

// React logs the caught render error to console.error; keep test output clean.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  reportMock.mockReset()
})

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>,
    )
    expect(screen.getByText('all good')).toBeInTheDocument()
    expect(reportMock).not.toHaveBeenCalled()
  })

  it('shows the fallback and reports the error when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument()
    expect(reportMock).toHaveBeenCalledOnce()
    expect(reportMock.mock.calls[0][0].message).toContain('kaboom')
  })
})
