/**
 * Only accept a same-origin relative path as a post-login redirect target --
 * mirrors the backend's own open-redirect guard on the OIDC callback's
 * next_path. A prefix check alone isn't enough: browsers normalize a
 * leading backslash to "/" when resolving a relative reference against an
 * http(s) base (WHATWG URL spec), so "/\\evil.com" would still resolve
 * off-site past a "//" check alone -- reject backslashes outright too.
 */
export function sanitizeNext(raw: string | null): string {
  if (!raw || raw.includes('\\') || !raw.startsWith('/') || raw.startsWith('//')) {
    return '/'
  }
  try {
    const parsed = new URL(raw, window.location.origin)
    if (parsed.origin !== window.location.origin) return '/'
  } catch {
    return '/'
  }
  return raw
}
