import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import config from '../config.js'
import { verifyJWT } from '../middleware/auth.js'
import { loginRateLimit } from '../middleware/rateLimit.js'
import {
  createUser,
  findUserByUsername,
  findUserByEmail,
  findUserByIdInternal,
  incrementTokenVersion,
} from '../db/queries.js'

function signAccess(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, tv: user.token_version },
    config.jwtSecret,
    { expiresIn: config.JWT_ACCESS_EXPIRES },
  )
}

function signRefresh(user) {
  return jwt.sign(
    { sub: user.id, tv: user.token_version },
    config.jwtRefreshSecret,
    { expiresIn: config.JWT_REFRESH_EXPIRES },
  )
}

export default async function authRoutes(fastify) {
  // ─── Register ───
  fastify.post('/api/auth/register', {
    schema: {
      body: {
        type: 'object',
        required: ['username', 'email', 'password'],
        properties: {
          username: { type: 'string', minLength: 2, maxLength: 30, pattern: '^[a-zA-Z0-9_]+$' },
          email: { type: 'string', format: 'email', maxLength: 255 },
          password: { type: 'string', minLength: 6, maxLength: 128 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { username, email, password } = request.body

    if (findUserByUsername(username)) {
      return reply.code(409).send({ error: 'USERNAME_TAKEN', message: '用户名已被占用' })
    }
    if (findUserByEmail(email)) {
      return reply.code(409).send({ error: 'EMAIL_TAKEN', message: '邮箱已被注册' })
    }

    const passwordHash = await bcrypt.hash(password, config.BCRYPT_ROUNDS)
    const id = createUser(username, email, passwordHash)

    return reply.code(201).send({ id, username, email })
  })

  // ─── Login ───
  fastify.post('/api/auth/login', {
    ...loginRateLimit,
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string' },
          password: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { username, password } = request.body
    const user = findUserByUsername(username)

    if (!user || !user.is_active) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS', message: '用户名或密码错误' })
    }
    if (user.password_hash === 'NO_LOGIN_ALLOWED') {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS', message: '用户名或密码错误' })
    }

    const valid = await bcrypt.compare(password, user.password_hash)
    if (!valid) {
      return reply.code(401).send({ error: 'INVALID_CREDENTIALS', message: '用户名或密码错误' })
    }

    // Trade-off: refreshToken returned in body, not HttpOnly cookie.
    // Simpler for M1; frontend must store carefully to mitigate XSS.
    return {
      accessToken: signAccess(user),
      refreshToken: signRefresh(user),
    }
  })

  // ─── Refresh ───
  fastify.post('/api/auth/refresh', {
    schema: {
      body: {
        type: 'object',
        required: ['refreshToken'],
        properties: {
          refreshToken: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { refreshToken } = request.body
    let payload
    try {
      payload = jwt.verify(refreshToken, config.jwtRefreshSecret)
    } catch {
      return reply.code(401).send({ error: 'INVALID_TOKEN', message: '刷新令牌无效或已过期' })
    }

    const user = findUserByIdInternal(payload.sub)
    if (!user || !user.is_active) {
      return reply.code(401).send({ error: 'INVALID_TOKEN', message: '用户不存在或已被禁用' })
    }
    if (user.token_version !== payload.tv) {
      return reply.code(401).send({ error: 'INVALID_TOKEN', message: '令牌已吊销' })
    }

    return { accessToken: signAccess(user) }
  })

  // ─── Logout ───
  // Trade-off: token_version is per-user, not per-device.
  // Logout invalidates ALL sessions across all devices.
  fastify.post('/api/auth/logout', {
    preHandler: [verifyJWT],
  }, async (request) => {
    incrementTokenVersion(request.user.id)
    return { message: '已登出' }
  })
}
