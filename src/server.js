import Fastify from 'fastify'
import cors from '@fastify/cors'
import config from './config.js'
import { registerRateLimit } from './middleware/rateLimit.js'
import { initializeDatabase, closeDb } from './db/init.js'
import authRoutes from './api/auth.js'
import userRoutes from './api/users.js'
import boardRoutes from './api/board.js'
import agentApiRoutes from './ai/agent_api.js'
import { startWorker, stopWorker } from './ai/queue.js'

export async function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger !== false ? { level: config.logLevel } : false,
    ...opts,
  })

  // ─── Plugins ───
  await app.register(cors, { origin: config.allowedOrigins })
  await registerRateLimit(app)

  // ─── Routes ───
  await app.register(authRoutes)
  await app.register(userRoutes)
  await app.register(boardRoutes)
  await app.register(agentApiRoutes)

  // ─── Global error handler ───
  app.setErrorHandler((error, request, reply) => {
    if (error.validation) {
      return reply.code(400).send({
        error: 'VALIDATION_ERROR',
        message: error.message,
      })
    }

    request.log.error(error)
    return reply.code(error.statusCode || 500).send({
      error: 'INTERNAL_ERROR',
      message: error.statusCode ? error.message : '服务器内部错误',
    })
  })

  return app
}

export async function startServer() {
  initializeDatabase()

  const app = await buildApp()

  const shutdown = async () => {
    app.log.info('Shutting down...')
    stopWorker()
    await app.close()
    closeDb()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await app.listen({ port: config.port, host: config.host })

  // Start AI job queue worker after server is listening
  startWorker()

  return app
}
