import jwt from 'jsonwebtoken'
import config from '../config.js'
import { findUserByIdInternal } from '../db/queries.js'

export async function verifyJWT(request, reply) {
  const auth = request.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) {
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: '缺少认证令牌' })
  }

  const token = auth.slice(7)
  let payload
  try {
    payload = jwt.verify(token, config.jwtSecret)
  } catch {
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: '令牌无效或已过期' })
  }

  const user = findUserByIdInternal(payload.sub)
  if (!user || !user.is_active) {
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: '用户不存在或已被禁用' })
  }
  if (user.token_version !== payload.tv) {
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: '令牌已吊销' })
  }

  request.user = {
    id: user.id,
    username: user.username,
    role: user.role,
  }
}

export async function requireAdmin(request, reply) {
  if (!request.user || request.user.role !== 'admin') {
    return reply.code(403).send({ error: 'FORBIDDEN', message: '需要管理员权限' })
  }
}
