import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'

/** SPA static serving: the built `web/dist` bundle. Registered last, after
 * every /api/* route, so the catch-all below only ever shadows routes that
 * don't otherwise exist. Ported from main.py's StaticFiles mount + SPA
 * catch-all. */
export async function registerStaticRoutes(
  app: FastifyInstance,
  dist: string,
): Promise<void> {
  // serve: false -- only decorate `reply.sendFile()`, no auto-registered
  // routes. `wildcard: false` alone isn't enough: it still glob-registers an
  // exact route per file (including index.html with default caching),
  // silently bypassing the catch-all's own index.html/no-cache handling below.
  await app.register(fastifyStatic, { root: dist, serve: false, decorateReply: true })

  const distResolved = resolve(dist)
  const indexPath = resolve(join(dist, 'index.html'))
  const indexHtml = readFileSync(indexPath)

  app.get('/*', (request, reply) => {
    const path = (request.params as { '*': string })['*'] ?? ''
    const full = resolve(join(dist, path))
    // Vite fingerprints asset filenames, so any real file under dist/ is
    // safe to serve as-is; index.html is always revalidated. Anything else
    // (an unknown path, or the client-routed SPA paths like /rules) falls
    // back to index.html so client-side routing works.
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
