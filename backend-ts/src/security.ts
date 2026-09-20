import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'

// index.html's bare inline <script> (sets the theme class pre-paint) needs
// its sha256 allow-listed for CSP -- computed from the built file so policy
// and file never drift. Doesn't match Vite's own <script type="module" src=...>.
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

/** Builds the CSP string; allow-lists every inline <script> hash when the SPA
 * is present, else script-src is just 'self'. */
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

/** Sets hardening headers on every response without clobbering ones a route set
 * itself. Register before any other plugin/route so it also decorates
 * static-file and SPA-catchall responses. */
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
