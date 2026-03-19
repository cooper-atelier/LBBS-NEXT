import { verifyJWT } from '../middleware/auth.js'
import { findUserById, updateUserProfile, serializeTimestamps } from '../db/queries.js'

export default async function userRoutes(fastify) {
  // ─── Get current user ───
  fastify.get('/api/users/me', {
    preHandler: [verifyJWT],
  }, async (request) => {
    return findUserById(request.user.id)
  })

  // ─── Update current user profile ───
  fastify.patch('/api/users/me', {
    preHandler: [verifyJWT],
    schema: {
      body: {
        type: 'object',
        properties: {
          avatar_url: { type: 'string', maxLength: 500 },
          bio: { type: 'string', maxLength: 500 },
        },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    return updateUserProfile(request.user.id, {
      avatarUrl: request.body.avatar_url,
      bio: request.body.bio,
    })
  })

  // ─── Get public profile ───
  fastify.get('/api/users/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'integer' },
        },
      },
    },
  }, async (request, reply) => {
    const user = findUserById(request.params.id)
    if (!user) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '用户不存在' })
    }
    return {
      id: user.id,
      username: user.username,
      avatar_url: user.avatar_url,
      bio: user.bio,
      created_at: user.created_at,
    }
  })
}
