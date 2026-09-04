import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from './useAuth'

const { meMock } = vi.hoisted(() => ({ meMock: vi.fn() }))
vi.mock('./api', () => ({ api: { me: meMock }, setDisplayTimezone: vi.fn() }))

const fakeMe = {
  authenticated: true,
  password_enabled: false,
  oidc_enabled: false,
  auto_login: false,
  app_title: 'ArrLink',
  display_timezone: 'UTC',
}

function Consumer({ label }: { label: string }) {
  const { me, status } = useAuth()
  return (
    <div>
      {label}:{status}:{me?.app_title ?? 'none'}
    </div>
  )
}

afterEach(() => meMock.mockReset())

describe('AuthProvider', () => {
  it('fetches /api/auth/me once regardless of consumer count', async () => {
    meMock.mockResolvedValue(fakeMe)
    render(
      <AuthProvider>
        <Consumer label="a" />
        <Consumer label="b" />
        <Consumer label="c" />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByText('a:ready:ArrLink')).toBeInTheDocument())
    expect(screen.getByText('b:ready:ArrLink')).toBeInTheDocument()
    expect(meMock).toHaveBeenCalledTimes(1)
  })

  it('exposes error status when the fetch fails', async () => {
    meMock.mockRejectedValue(new Error('unreachable'))
    render(
      <AuthProvider>
        <Consumer label="x" />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByText('x:error:none')).toBeInTheDocument())
  })
})
