import { sha256 } from '../utils/crypto.js'
import {
  findAgentByToken, findActiveJob, updateJobStatus,
  createComment, createAgentLog,
} from '../db/queries.js'
import config from '../config.js'

export default async function agentApiRoutes(fastify) {
  fastify.post('/api/ai/reply', {
    schema: {
      body: {
        type: 'object',
        required: ['post_id', 'target_type', 'target_id', 'content'],
        properties: {
          post_id: { type: 'integer' },
          target_type: { type: 'string', enum: ['post', 'comment'] },
          target_id: { type: 'integer' },
          content: { type: 'string', minLength: 1, maxLength: 50000 },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    // 1. Verify Agent Token (not JWT — this is agent bearer token)
    const auth = request.headers.authorization
    if (!auth || !auth.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: '缺少 Agent Token' })
    }
    const rawToken = auth.slice(7)
    const tokenHash = sha256(rawToken)
    const agent = findAgentByToken(tokenHash)

    if (!agent || agent.is_deleted || !agent.is_active) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Agent Token 无效' })
    }

    const { post_id, target_type, target_id, content } = request.body

    // 2. Anti-spam: must find matching job in job_queue (architecture constraint #10)
    const job = findActiveJob(agent.id, post_id)
    if (!job) {
      return reply.code(403).send({
        error: 'FORBIDDEN',
        message: '未找到对应的待处理任务，回写被拒绝',
      })
    }

    // 3. Write comment
    const authorId = agent.owner_id ?? config.SYSTEM_USER_ID
    const parentId = target_type === 'comment' ? target_id : null
    const comment = createComment(post_id, authorId, content, parentId, agent.id)

    // 4. Mark job done
    updateJobStatus(job.id, 'done')
    createAgentLog(agent.id, job.id, 'done')

    return reply.code(201).send({ ok: true, comment_id: comment.id })
  })
}
