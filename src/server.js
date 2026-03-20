import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import config from './config.js'
import { registerRateLimit } from './middleware/rateLimit.js'
import { initializeDatabase, closeDb } from './db/init.js'
import authRoutes from './api/auth.js'
import userRoutes from './api/users.js'
import boardRoutes from './api/board.js'
import agentApiRoutes from './ai/agent_api.js'
import agentRoutes from './api/agents.js'
import adminRoutes from './api/admin.js'
import { startWorker, stopWorker } from './ai/queue.js'
import { initSocket } from './ws/socket.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger !== false ? { level: config.logLevel } : false,
    ...opts,
  })

  // ─── Plugins ───
  await app.register(cors, { origin: config.allowedOrigins })
  await registerRateLimit(app)
  await app.register(fastifyStatic, {
    root: join(__dirname, '..', 'public'),
    prefix: '/',
  })

  // ─── Routes ───
  await app.register(authRoutes)
  await app.register(userRoutes)
  await app.register(boardRoutes)
  await app.register(agentApiRoutes)
  await app.register(agentRoutes)
  await app.register(adminRoutes)

  // ─── SPA fallback ───
  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api/')) {
      return reply.sendFile('index.html')
    }
    reply.code(404).send({ error: 'NOT_FOUND', message: '资源不存在' })
  })

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

  // Init socket.io on the underlying HTTP server
  initSocket(app.server)

  // Start AI job queue worker after server is listening
  startWorker()

  return app
}
