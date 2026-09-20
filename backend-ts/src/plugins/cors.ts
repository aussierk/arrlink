import type { FastifyInstance } from 'fastify'

const DEV_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173'])

/** Permissive CORS for the Vite dev server -- opt-in (ENABLE_DEV_CORS).
 * Ported from main.py's CORSMiddleware wiring. */
export function registerDevCors(app: FastifyInstance): void {
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin
    if (!origin || !DEV_ORIGINS.has(origin)) return

    reply.header('access-control-allow-origin', origin)
    reply.header('vary', 'Origin')

    if (request.method === 'OPTIONS') {
      const reqMethod = request.headers['access-control-request-method']
      const reqHeaders = request.headers['access-control-request-headers']
      if (reqMethod) {
        reply.header('access-control-allow-methods', reqMethod)
        if (reqHeaders) reply.header('access-control-allow-headers', reqHeaders)
        reply.code(204).send()
      }
    }
  })
}
