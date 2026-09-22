import { describe, expect, it } from 'vitest'
import {
  PRESETS,
  defaultBaseFolder,
  getPreset,
  listPresetsForType,
  renderPreset,
} from '../../src/core/presets.js'

describe('presets', () => {
  it('has a matcher for every app type it declares support for', () => {
    for (const p of PRESETS) {
      const appTypes = p.appTypes ?? (['radarr', 'sonarr'] as const)
      for (const appType of appTypes) {
        expect(p.matchers[appType]).toBeDefined()
      }
    }
  })

  it('defaults the base folder by app type', () => {
    expect(defaultBaseFolder('radarr')).toBe('/media/movies')
    expect(defaultBaseFolder('sonarr')).toBe('/media/tv')
    expect(defaultBaseFolder('unknown')).toBe('/media')
  })

  it('renders every applicable preset for a type with a dir_template built from the base folder', () => {
    const rendered = listPresetsForType('radarr')
    const expectedCount = PRESETS.filter(
      (p) => !p.appTypes || p.appTypes.includes('radarr'),
    ).length
    expect(rendered).toHaveLength(expectedCount)
    // Sonarr-only presets (network/anime) must not leak into Radarr's list.
    expect(rendered.some((p) => p.key === 'network' || p.key === 'anime')).toBe(false)
    const kids = rendered.find((p) => p.key === 'kids')!
    expect(kids.dirTemplate).toBe('/media/movies/kids')
    expect(kids.matchType).toBe('regex')
  })

  it('respects a custom base folder override, trimming a trailing slash', () => {
    const rendered = listPresetsForType('radarr', '/custom/base/')
    const kids = rendered.find((p) => p.key === 'kids')!
    expect(kids.dirTemplate).toBe('/custom/base/kids')
  })

  it('renders one preset by key', () => {
    const rendered = renderPreset('4k', 'sonarr')
    expect(rendered?.dirTemplate).toBe('/media/tv/4k')
    expect(rendered?.baseFolder).toBe('/media/tv')
  })

  it('returns undefined for an unknown preset key', () => {
    expect(renderPreset('does-not-exist', 'radarr')).toBeUndefined()
    expect(getPreset('does-not-exist')).toBeUndefined()
  })

  it('returns undefined for a preset applied to the wrong app type', () => {
    expect(renderPreset('studio', 'sonarr')).toBeUndefined()
    expect(renderPreset('network', 'radarr')).toBeUndefined()
    expect(renderPreset('studio', 'radarr')?.dirTemplate).toBe('/media/movies/{$studio}')
  })

  it('placeholder-based presets carry the {$...} token through unresolved', () => {
    const user = renderPreset('user', 'radarr')!
    expect(user.dirTemplate).toBe('/media/movies/{$user}')
  })
})
