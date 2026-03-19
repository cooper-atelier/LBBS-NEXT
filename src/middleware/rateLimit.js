import config from '../config.js'

export async function registerRateLimit(fastify) {
  await fastify.register(import('@fastify/rate-limit'), {
    max: config.RATE_LIMIT_GLOBAL,
    timeWindow: '1 minute',
  })
}

export const loginRateLimit = {
  config: {
    rateLimit: {
      max: config.RATE_LIMIT_LOGIN,
      timeWindow: '1 minute',
    },
  },
}
