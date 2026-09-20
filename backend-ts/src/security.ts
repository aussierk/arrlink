import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'

// The built web/dist/index.html carries a bare inline <script> that runs
// before first paint to set the theme class (see web/index.html). CSP
// forbids inline script unless its exact sha256 is allow-listed -- computed
// from the built file here so the policy and the file never drift. Vite
// emits its own module script with attributes (<script type="module"
// src=...>), which this bare-tag pattern deliberately does not match.
const INLINE_SCRIPT_RE = /<script>([\s\S]*?)<\/script>/g

function cspTemplate(scriptHashes: string): string {
  return (
    `default-src 'self'; ` +
    `script-src 'self'${scriptHashes}; ` +
    `style-src 'self' 'unsafe-inline'; ` +
    `img-src 'self' data:; ` +
    `font-src 'self'; ` +
    `connect-src 'self'; ` +
    `frame-ancestors 'none'; ` +
    `base-uri 'none'; ` +
    `form-action 'self'; ` +
    `object-src 'none'`
  )
}

function sha256Base64(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('base64')
}

/**
 * Builds the Content-Security-Policy string. When the built SPA is
 * present, every bare inline <script> in its index.html is allow-listed by
 * sha256; otherwise script-src is just 'self' (pure-API runs, or the Vite
 * dev server, which serves its own unhashed scripts and isn't behind this
 * hook anyway).
 */
export function buildCsp(indexHtmlPath: string | null): string {
  let hashes = ''
  if (indexHtmlPath && existsSync(indexHtmlPath)) {
    const html = readFileSync(indexHtmlPath, 'utf-8')
    for (const match of html.matchAll(INLINE_SCRIPT_RE)) {
      hashes += ` 'sha256-${sha256Base64(match[1])}'`
    }
  }
  return cspTemplate(hashes)
}

function securityHeaders(csp: string): ReadonlyArray<readonly [string, string]> {
  return [
    ['content-security-policy', csp],
    ['x-content-type-options', 'nosniff'],
    ['referrer-policy', 'no-referrer'],
    ['x-frame-options', 'DENY'],
    ['cross-origin-opener-policy', 'same-origin'],
  ]
}

/**
 * Sets hardening headers on every HTTP response, without clobbering any a
 * route set itself. Register this before any other plugin/route so it also
 * decorates static-file and SPA-catchall responses (ported from
 * security.py::SecurityHeadersMiddleware, which is the outermost ASGI
 * middleware for the same reason).
 */
export function registerSecurityHeaders(app: FastifyInstance, csp: string): void {
  const headers = securityHeaders(csp)
  app.addHook('onSend', (_req, reply, payload, done) => {
    for (const [key, value] of headers) {
      if (reply.getHeader(key) === undefined) {
        reply.header(key, value)
      }
    }
    done(null, payload)
  })
}
