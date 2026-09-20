import type { FastifyInstance } from 'fastify'

/** Opt-in Host-header allow-list (TRUSTED_HOSTS env) -- unset by default.
 * Ported from main.py's TrustedHostMiddleware wiring. */
export function registerTrustedHost(
  app: FastifyInstance,
  trustedHosts: string | undefined,
): void {
  const configured = (trustedHosts ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  if (configured.length === 0) return

  const hosts = new Set(configured)
  for (const loopback of ['127.0.0.1', 'localhost', '::1']) hosts.add(loopback)

  app.addHook('onRequest', async (request, reply) => {
    const host = (request.headers.host ?? '').split(':')[0]
    if (!isAllowedHost(host, hosts)) {
      reply.code(400).type('text/plain').send('Invalid host header')
    }
  })
}

function isAllowedHost(host: string, hosts: Set<string>): boolean {
  for (const pattern of hosts) {
    if (host === pattern) return true
    // Starlette-style wildcard: "*.example.com" matches "sub.example.com"
    // (host.endsWith(pattern without the leading "*")).
    if (pattern.startsWith('*') && host.endsWith(pattern.slice(1))) return true
  }
  return false
}
