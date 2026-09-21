import type { EventEmitter } from 'node:events'
import pino from 'pino'
import type { FastifyBaseLogger } from 'fastify'
import type { Settings } from './config/env.js'

// pino's ThreadStream type is `any`; narrow it to what we actually use.
interface TransportStream extends EventEmitter {
  write(msg: string): boolean
  end(): void
}

// Mirrors Python's _LOG_BACKUP_COUNT (config.py); not user-configurable.
const LOG_BACKUP_COUNT = 3

export interface AppLogger {
  logger: FastifyBaseLogger
  /** Ends the transport's worker thread. Without this, Fastify's app.close()
   * doesn't know about our external transport and leaves it running, which
   * races config-dir teardown in tests (pino-roll tries to write/rotate into
   * a directory that's already been removed). */
  close: () => Promise<void>
}

/** Process logger: stdout plus a size-capped rotating file at settings.logPath. */
export function createLogger(settings: Settings, level: string, sizeMb: number): AppLogger {
  const transport: TransportStream = pino.transport({
    targets: [
      { target: 'pino/file', level, options: { destination: 1 } },
      {
        target: 'pino-roll',
        level,
        options: {
          file: settings.logPath,
          size: `${sizeMb}m`,
          mkdir: true,
          limit: { count: LOG_BACKUP_COUNT },
        },
      },
    ],
  }) as TransportStream
  const logger = pino({ level }, transport)
  const close = (): Promise<void> =>
    new Promise((resolve) => {
      transport.on('close', () => resolve())
      transport.end()
    })
  return { logger, close }
}
