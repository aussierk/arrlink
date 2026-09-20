import { describe, expect, it } from 'vitest'
import {
  PRESETS,
  defaultBaseFolder,
  getPreset,
  listPresetsForType,
  renderPreset,
} from '../../src/core/presets.js'

describe('presets', () => {
  it('has a Radarr and Sonarr matcher for every preset', () => {
    for (const p of PRESETS) {
      expect(p.matchers.radarr).toBeDefined()
      expect(p.matchers.sonarr).toBeDefined()
    }
  })

  it('defaults the base folder by app type', () => {
    expect(defaultBaseFolder('radarr')).toBe('/media/movies')
    expect(defaultBaseFolder('sonarr')).toBe('/media/tv')
    expect(defaultBaseFolder('unknown')).toBe('/media')
  })

  it('renders every preset for a type with a dir_template built from the base folder', () => {
    const rendered = listPresetsForType('radarr')
    expect(rendered).toHaveLength(PRESETS.length)
    const kids = rendered.find((p) => p.key === 'kids')!
    expect(kids.dirTemplate).toBe('/media/movies/kids')
    expect(kids.matchType).toBe('list')
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

  it('placeholder-based presets carry the {$...} token through unresolved', () => {
    const user = renderPreset('user', 'radarr')!
    expect(user.dirTemplate).toBe('/media/movies/{$user}')
  })
})
