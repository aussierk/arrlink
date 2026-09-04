import { describe, expect, it } from 'vitest'
import { logLevelClass } from './useLogStream'

describe('logLevelClass', () => {
  it('maps known levels', () => {
    expect(logLevelClass('error')).toBe('text-danger-fg')
    expect(logLevelClass('warn')).toBe('text-warning-fg')
  })

  it('falls back for info / unknown', () => {
    expect(logLevelClass('info')).toBe('text-fg-muted')
    expect(logLevelClass('anything-else')).toBe('text-fg-muted')
  })
})
