import { verifyJWT, requireAdmin } from '../middleware/auth.js'
import { ownerOrAdmin } from '../middleware/validate.js'
import {
  createBoard, listBoards, findBoardById,
  createPost, listPostsByBoard, findPostById, updatePost, softDeletePost, findPostOwner,
  createComment, listCommentsByPost, updateComment, softDeleteComment, findCommentOwner,
} from '../db/queries.js'
import { extractMentionsWithContext } from '../ai/detector.js'
import { dispatchMentions } from '../ai/dispatcher.js'

export default async function boardRoutes(fastify) {
  // ═══ Boards ═══

  fastify.get('/api/boards', async () => {
    return listBoards()
  })

  fastify.post('/api/boards', {
    preHandler: [verifyJWT, requireAdmin],
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 50 },
          description: { type: 'string', maxLength: 500 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { name, description } = request.body
    const existing = listBoards().find(b => b.name === name)
    if (existing) {
      return reply.code(409).send({ error: 'BOARD_EXISTS', message: '板块名称已存在' })
    }
    const board = createBoard(name, description, request.user.id)
    return reply.code(201).send(board)
  })

  // ═══ Posts ═══

  fastify.get('/api/boards/:id/posts', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
      querystring: {
        type: 'object',
        properties: {
          cursor: { type: 'integer' },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
    },
  }, async (request, reply) => {
    const board = findBoardById(request.params.id)
    if (!board) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '板块不存在' })
    }
    const { cursor, limit } = request.query
    return listPostsByBoard(request.params.id, { cursor, limit })
  })

  fastify.post('/api/boards/:id/posts', {
    preHandler: [verifyJWT],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
      body: {
        type: 'object',
        required: ['title', 'content'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          content: { type: 'string', minLength: 1, maxLength: 50000 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const board = findBoardById(request.params.id)
    if (!board) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '板块不存在' })
    }
    const post = createPost(request.params.id, request.user.id, request.body.title, request.body.content)
    reply.code(201).send(post)

    // Fire-and-forget AI dispatch after response (architecture decision #3)
    try {
      const mentions = extractMentionsWithContext(request.body.content)
      if (mentions.length > 0) {
        dispatchMentions({ mentions, postId: post.id, commentId: null, triggeredBy: request.user.id })
      }
    } catch (err) {
      request.log.error(err, 'AI dispatch failed for post %d', post.id)
    }
  })

  fastify.get('/api/posts/:id', {
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
    },
  }, async (request, reply) => {
    const post = findPostById(request.params.id)
    if (!post) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '帖子不存在' })
    }

    const comments = listCommentsByPost(request.params.id)
    // Soft-deleted: replace content but keep structure
    const maskedComments = comments.map(c => {
      if (c.is_deleted) {
        return { ...c, content: '[此内容已删除]' }
      }
      return c
    })

    const postData = post.is_deleted
      ? { ...post, title: '[此内容已删除]', content: '[此内容已删除]' }
      : post

    return { ...postData, comments: maskedComments }
  })

  fastify.patch('/api/posts/:id', {
    preHandler: [verifyJWT],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
      body: {
        type: 'object',
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          content: { type: 'string', minLength: 1, maxLength: 50000 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const ownerId = findPostOwner(request.params.id)
    if (ownerId === null) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '帖子不存在' })
    }
    if (!ownerOrAdmin(request, reply, ownerId)) return

    const post = updatePost(request.params.id, request.body)
    return post
  })

  fastify.delete('/api/posts/:id', {
    preHandler: [verifyJWT],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
    },
  }, async (request, reply) => {
    const ownerId = findPostOwner(request.params.id)
    if (ownerId === null) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '帖子不存在' })
    }
    if (!ownerOrAdmin(request, reply, ownerId)) return

    softDeletePost(request.params.id)
    return { message: '帖子已删除' }
  })

  // ═══ Comments ═══

  fastify.post('/api/posts/:id/comments', {
    preHandler: [verifyJWT],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 10000 },
          parent_id: { type: 'integer' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const post = findPostById(request.params.id)
    if (!post) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '帖子不存在' })
    }

    const { content, parent_id } = request.body

    let comment
    try {
      comment = createComment(request.params.id, request.user.id, content, parent_id || null)
    } catch (err) {
      if (err.code === 'NOT_FOUND') return reply.code(404).send({ error: 'NOT_FOUND', message: err.message })
      if (err.code === 'INVALID_PARENT') return reply.code(400).send({ error: 'INVALID_PARENT', message: err.message })
      if (err.code === 'NESTING_LIMIT') return reply.code(400).send({ error: 'NESTING_LIMIT', message: err.message })
      throw err
    }
    reply.code(201).send(comment)

    // Fire-and-forget AI dispatch after response (architecture decision #3)
    try {
      const mentions = extractMentionsWithContext(content)
      if (mentions.length > 0) {
        dispatchMentions({ mentions, postId: request.params.id, commentId: comment.id, triggeredBy: request.user.id })
      }
    } catch (err) {
      request.log.error(err, 'AI dispatch failed for comment %d', comment.id)
    }
  })

  fastify.patch('/api/comments/:id', {
    preHandler: [verifyJWT],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', minLength: 1, maxLength: 10000 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const ownerId = findCommentOwner(request.params.id)
    if (ownerId === null) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '评论不存在' })
    }
    if (!ownerOrAdmin(request, reply, ownerId)) return

    const comment = updateComment(request.params.id, request.body.content)
    return comment
  })

  fastify.delete('/api/comments/:id', {
    preHandler: [verifyJWT],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
    },
  }, async (request, reply) => {
    const ownerId = findCommentOwner(request.params.id)
    if (ownerId === null) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '评论不存在' })
    }
    if (!ownerOrAdmin(request, reply, ownerId)) return

    softDeleteComment(request.params.id)
    return { message: '评论已删除' }
  })
}
