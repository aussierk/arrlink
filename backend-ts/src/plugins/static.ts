import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'

/** SPA static serving. Registered last so it only shadows routes that don't
 * otherwise exist. Ported from main.py's StaticFiles mount + SPA catch-all. */
export async function registerStaticRoutes(
  app: FastifyInstance,
  dist: string,
): Promise<void> {
  // serve: false -- decorates reply.sendFile() only, no auto-registered
  // routes. `wildcard: false` alone still glob-registers a route per file
  // (incl. index.html with default caching), bypassing the fallback below.
  await app.register(fastifyStatic, { root: dist, serve: false, decorateReply: true })

  const distResolved = resolve(dist)
  const indexPath = resolve(join(dist, 'index.html'))
  const indexHtml = readFileSync(indexPath)

  app.get('/*', (request, reply) => {
    const path = (request.params as { '*': string })['*'] ?? ''
    const full = resolve(join(dist, path))
    // Any real file under dist/ is safe to serve as-is; anything else
    // (SPA client routes, unknown paths) falls back to index.html.
    const isRealFile =
      path !== '' &&
      (full === distResolved || full.startsWith(distResolved + sep)) &&
      full !== indexPath &&
      existsSync(full) &&
      statSync(full).isFile()
    if (isRealFile) {
      return reply.sendFile(path)
    }
    reply.header('cache-control', 'no-cache')
    return reply.type('text/html').send(indexHtml)
  })
}
