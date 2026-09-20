import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyTheme } from './useTheme'

function mockPrefersDark(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  )
}

afterEach(() => {
  document.documentElement.classList.remove('dark')
  vi.unstubAllGlobals()
})

describe('applyTheme', () => {
  it('adds the dark class for "dark"', () => {
    mockPrefersDark(false)
    applyTheme('dark')
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })

  it('removes the dark class for "light"', () => {
    mockPrefersDark(true)
    document.documentElement.classList.add('dark')
    applyTheme('light')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })

  it('follows the OS preference for "system"', () => {
    mockPrefersDark(true)
    applyTheme('system')
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    mockPrefersDark(false)
    applyTheme('system')
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})
