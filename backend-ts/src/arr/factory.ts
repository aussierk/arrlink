import type { BaseAdapter } from './base.js'
import { RadarrAdapter } from './radarr.js'
import { SonarrAdapter } from './sonarr.js'

const DEFAULT_TIMEOUT_MS = 15_000

export function getAdapter(
  appType: string,
  url: string,
  apiKey: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): BaseAdapter {
  switch (appType) {
    case 'radarr':
      return new RadarrAdapter(url, apiKey, timeoutMs)
    case 'sonarr':
      return new SonarrAdapter(url, apiKey, timeoutMs)
    default:
      throw new Error(`unsupported app type: ${appType}`)
  }
}
