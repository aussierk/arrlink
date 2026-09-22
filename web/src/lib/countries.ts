/**
 * Countries TMDB's /certification/{movie,tv}/list endpoint commonly returns
 * a non-empty certification scheme for -- a curated, not exhaustive, list
 * (TMDB doesn't have meaningful certification data for most ISO-3166
 * countries). Settings > General > Region uses this to show full country
 * names while sending TMDB's 2-letter code. If a country you need isn't
 * here, add it -- the backend accepts any code, this is just the picker.
 */
export const TMDB_CERTIFICATION_COUNTRIES: { code: string; name: string }[] = [
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'NZ', name: 'New Zealand' },
  { code: 'IE', name: 'Ireland' },
  { code: 'IN', name: 'India' },
  { code: 'JP', name: 'Japan' },
  { code: 'BR', name: 'Brazil' },
  { code: 'ES', name: 'Spain' },
  { code: 'IT', name: 'Italy' },
  { code: 'NL', name: 'Netherlands' },
]
