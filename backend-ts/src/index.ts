import { loadSettings } from './config/env.js'
import { createApp } from './app.js'

async function main(): Promise<void> {
  const settings = await loadSettings()
  const { app, close } = await createApp(settings)

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    app.log.info(`received ${signal}, shutting down`)
    close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        console.error(err)
        process.exit(1)
      })
  }
  process.on('SIGTERM', () => {
    shutdown('SIGTERM')
  })
  process.on('SIGINT', () => {
    shutdown('SIGINT')
  })

  await app.listen({ host: '0.0.0.0', port: settings.port })
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
