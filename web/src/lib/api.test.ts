import { afterEach, describe, expect, it, vi } from 'vitest'
import { fmtRelative, fmtTime, readAuthErrorCookie, setDisplayTimezone } from './api'

describe('fmtTime', () => {
  afterEach(() => setDisplayTimezone('UTC'))

  it('renders "—" for a missing timestamp', () => {
    expect(fmtTime(null)).toBe('—')
    expect(fmtTime(0)).toBe('—')
  })

  it('renders in the configured display timezone', () => {
    // 2021-01-01T00:00:00Z
    const ts = 1609459200
    setDisplayTimezone('UTC')
    const utc = fmtTime(ts)
    setDisplayTimezone('America/New_York')
    const ny = fmtTime(ts)
    expect(utc).not.toBe(ny)
    expect(ny).toMatch(/2020/) // 19:00 on 2020-12-31 in New York
  })
})

describe('fmtRelative', () => {
  afterEach(() => vi.useRealTimers())

  it('renders "—" for a missing timestamp', () => {
    expect(fmtRelative(null)).toBe('—')
  })

  it('picks a sensible unit around "now"', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2022-06-01T12:00:00Z'))
    const now = Date.now() / 1000
    expect(fmtRelative(now - 30)).toMatch(/second/)
    expect(fmtRelative(now - 5 * 60)).toMatch(/minute/)
    expect(fmtRelative(now + 3 * 3600)).toMatch(/hour/)
    expect(fmtRelative(now - 4 * 86400)).toMatch(/day/)
  })
})

describe('readAuthErrorCookie', () => {
  afterEach(() => {
    document.cookie = 'arrlink_auth_error=; Max-Age=0; path=/'
  })

  it('returns null when the cookie is absent', () => {
    expect(readAuthErrorCookie()).toBeNull()
  })

  it('decodes the cookie value when present', () => {
    document.cookie = 'arrlink_auth_error=' + encodeURIComponent('not_authorized')
    expect(readAuthErrorCookie()).toBe('not_authorized')
  })
})
