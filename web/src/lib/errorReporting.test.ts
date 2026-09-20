import { describe, expect, it } from 'vitest'
import { createRateLimiter, describeThrown } from './errorReporting'

describe('createRateLimiter', () => {
  it('allows the first message', () => {
    const allowed = createRateLimiter(5)
    expect(allowed('boom')).toBe(true)
  })

  it('blocks an identical consecutive message', () => {
    const allowed = createRateLimiter(5)
    allowed('boom')
    expect(allowed('boom')).toBe(false)
  })

  it('allows a different message even right after a block', () => {
    const allowed = createRateLimiter(5)
    allowed('boom')
    expect(allowed('bang')).toBe(true)
  })

  it('caps at maxPerMinute within the same window', () => {
    let t = 0
    const allowed = createRateLimiter(2, () => t)
    expect(allowed('a')).toBe(true)
    t += 1000
    expect(allowed('b')).toBe(true)
    t += 1000
    expect(allowed('c')).toBe(false) // 3rd distinct message, still under a minute
  })

  it('resets the cap once the rolling window elapses', () => {
    let t = 0
    const allowed = createRateLimiter(1, () => t)
    expect(allowed('a')).toBe(true)
    t += 1000
    expect(allowed('b')).toBe(false) // still within the same 60s window, cap=1 already used
    t += 60_001
    expect(allowed('c')).toBe(true) // new window
  })
})

describe('describeThrown', () => {
  it('formats an Error as "Name: message" with its stack', () => {
    const err = new TypeError('bad input')
    const { message, stack } = describeThrown(err, 'Error')
    expect(message).toBe('TypeError: bad input')
    expect(stack).toBe(err.stack ?? '')
  })

  it('falls back to a prefixed String() for a non-Error value, with no stack', () => {
    expect(describeThrown('just a string', 'Unhandled rejection')).toEqual({
      message: 'Unhandled rejection: just a string',
      stack: '',
    })
    expect(describeThrown(404, 'Error')).toEqual({ message: 'Error: 404', stack: '' })
  })
})
