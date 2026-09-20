import { describe, expect, it } from 'vitest'
import { getAdapter } from '../../src/arr/factory.js'
import { RadarrAdapter } from '../../src/arr/radarr.js'
import { SonarrAdapter } from '../../src/arr/sonarr.js'

describe('getAdapter', () => {
  it('registers both the Radarr and Sonarr adapters', () => {
    expect(getAdapter('radarr', 'http://x', 'k')).toBeInstanceOf(RadarrAdapter)
    expect(getAdapter('sonarr', 'http://x', 'k')).toBeInstanceOf(SonarrAdapter)
    expect(getAdapter('radarr', 'http://x', 'k').appType).toBe('radarr')
    expect(getAdapter('sonarr', 'http://x', 'k').appType).toBe('sonarr')
  })

  it('throws for an unsupported app type', () => {
    expect(() => getAdapter('lidarr', 'http://x', 'k')).toThrow(/unsupported app type/)
  })
})
