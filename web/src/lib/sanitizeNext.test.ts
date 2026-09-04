import { describe, expect, it } from 'vitest'
import { sanitizeNext } from './sanitizeNext'

describe('sanitizeNext', () => {
  it('keeps a plain same-origin path', () => {
    expect(sanitizeNext('/rules')).toBe('/rules')
    expect(sanitizeNext('/settings/authentication?tab=oidc')).toBe(
      '/settings/authentication?tab=oidc',
    )
  })

  it('falls back to / for empty or non-absolute input', () => {
    expect(sanitizeNext(null)).toBe('/')
    expect(sanitizeNext('')).toBe('/')
    expect(sanitizeNext('rules')).toBe('/')
  })

  it('rejects protocol-relative and backslash open-redirect payloads', () => {
    expect(sanitizeNext('//evil.com')).toBe('/')
    expect(sanitizeNext('/\\evil.com')).toBe('/')
    expect(sanitizeNext('/\\/evil.com')).toBe('/')
  })

  it('rejects absolute off-origin URLs', () => {
    expect(sanitizeNext('https://evil.com')).toBe('/')
    expect(sanitizeNext('http://evil.com/path')).toBe('/')
  })
})
