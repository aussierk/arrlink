import { useCallback, useEffect, useState } from 'react'

export type Theme = 'light' | 'dark' | 'system'

const KEY = 'arrlink_theme'
const mql = () => window.matchMedia('(prefers-color-scheme: dark)')

/** Read the stored preference; missing/invalid -> 'system'. */
function read(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* private mode / storage disabled */
  }
  return 'system'
}

/** Apply a resolved theme to <html> by toggling `.dark`. Kept in sync with
 * the inline pre-hydration script in index.html (which runs before React to
 * avoid a flash). */
export function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && mql().matches)
  document.documentElement.classList.toggle('dark', dark)
}

/**
 * Theme state: 'light' | 'dark' | 'system', persisted to localStorage and
 * reflected onto <html class="dark">. 'system' follows the OS setting live.
 */
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(read)

  useEffect(() => {
    applyTheme(theme)
    if (theme !== 'system') return
    const m = mql()
    const onChange = () => applyTheme('system')
    m.addEventListener('change', onChange)
    return () => m.removeEventListener('change', onChange)
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    try {
      localStorage.setItem(KEY, next)
    } catch {
      /* ignore */
    }
    setThemeState(next)
  }, [])

  return { theme, setTheme }
}
