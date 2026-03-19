import { randomBytes } from 'node:crypto'
import { verifyJWT } from '../middleware/auth.js'
import { sha256, encrypt } from '../utils/crypto.js'
import { AGENT_NAME_PATTERN_JS } from '../ai/detector.js'
import {
  listAgentsByOwner,
  createAgent,
  findAgentOwner,
  findAgentById,
  updateAgent,
  softDeleteAgent,
  updateAgentToken,
  findPublicAgentByName,
} from '../db/queries.js'

const AGENT_NAME_SCHEMA = { type: 'string', pattern: AGENT_NAME_PATTERN_JS, minLength: 1, maxLength: 32 }
const MODEL_TYPES = ['openai', 'anthropic', 'custom_webhook']

export default async function agentRoutes(app) {
  // ─── GET /api/agents/mine ───
  app.get('/api/agents/mine', {
    preHandler: [verifyJWT],
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            agents: { type: 'array' },
          },
        },
      },
    },
  }, async (request) => {
    const agents = listAgentsByOwner(request.user.id)
    return { agents }
  })

  // ─── POST /api/agents ───
  app.post('/api/agents', {
    preHandler: [verifyJWT],
    schema: {
      body: {
        type: 'object',
        required: ['name', 'model_type'],
        additionalProperties: false,
        properties: {
          name: AGENT_NAME_SCHEMA,
          model_type: { type: 'string', enum: MODEL_TYPES },
          model_name: { type: 'string', maxLength: 100 },
          system_prompt: { type: 'string', maxLength: 4000 },
          api_key: { type: 'string', maxLength: 500 },
          webhook_url: { type: 'string', format: 'uri', maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    const { name, model_type, model_name, system_prompt, api_key, webhook_url } = request.body

    // 坑1: Block if name is taken by a public agent
    if (findPublicAgentByName(name)) {
      return reply.code(409).send({ error: 'NAME_RESERVED', message: '此名称已被公共 AI 保留' })
    }

    // 坑4: Validate config matches model_type
    if (model_type === 'custom_webhook' && !webhook_url) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Webhook 模式必须提供 webhook_url' })
    }
    if (model_type !== 'custom_webhook' && !api_key) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: '直连模式必须提供 api_key' })
    }

    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = sha256(rawToken)
    const webhookSecret = randomBytes(32).toString('hex')

    const apiKeyEnc = api_key ? encrypt(api_key) : null
    // Only store webhook fields for webhook mode
    const finalWebhookUrl = model_type === 'custom_webhook' ? webhook_url : null
    const finalWebhookSecret = model_type === 'custom_webhook' ? webhookSecret : null

    const agent = createAgent(name, request.user.id, tokenHash, {
      apiKeyEnc,
      webhookUrl: finalWebhookUrl,
      webhookSecret: finalWebhookSecret,
      modelType: model_type,
      modelName: model_name || null,
      systemPrompt: system_prompt || null,
    })

    return reply.code(201).send({
      agent,
      raw_token: rawToken,
      webhook_secret: model_type === 'custom_webhook' ? webhookSecret : undefined,
    })
  })

  // ─── PATCH /api/agents/:id ───
  app.patch('/api/agents/:id', {
    preHandler: [verifyJWT],
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
      },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: AGENT_NAME_SCHEMA,
          model_type: { type: 'string', enum: MODEL_TYPES },
          model_name: { type: 'string', maxLength: 100 },
          system_prompt: { type: 'string', maxLength: 4000 },
          api_key: { type: 'string', maxLength: 500 },
          webhook_url: { type: ['string', 'null'], format: 'uri', maxLength: 500 },
          is_active: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params
    const ownerId = findAgentOwner(id)
    if (ownerId === undefined) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Agent 不存在' })
    }
    if (ownerId !== request.user.id) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: '无权操作此 Agent' })
    }

    const existing = findAgentById(id)
    if (existing.is_deleted) {
      return reply.code(410).send({ error: 'GONE', message: 'Agent 已被删除' })
    }

    const { name, model_type, model_name, system_prompt, api_key, webhook_url, is_active } = request.body

    // 坑1: If renaming, check public namespace collision
    if (name && findPublicAgentByName(name)) {
      return reply.code(409).send({ error: 'NAME_RESERVED', message: '此名称已被公共 AI 保留' })
    }

    // Determine effective model_type after this update
    const effectiveModelType = model_type || existing.model_type

    // 坑4: Clean up stale config when switching model_type
    const fields = {}
    if (name !== undefined) fields.name = name
    if (model_type !== undefined) fields.modelType = model_type
    if (model_name !== undefined) fields.modelName = model_name
    if (system_prompt !== undefined) fields.systemPrompt = system_prompt
    if (is_active !== undefined) fields.isActive = is_active ? 1 : 0

    if (api_key !== undefined) {
      fields.apiKeyEnc = api_key ? encrypt(api_key) : null
    }

    if (effectiveModelType === 'custom_webhook') {
      // Webhook mode: accept webhook_url updates, clear api_key if switching to webhook
      if (webhook_url !== undefined) fields.webhookUrl = webhook_url || null
      if (model_type !== undefined && model_type === 'custom_webhook') {
        fields.apiKeyEnc = api_key ? encrypt(api_key) : null
      }
      // If webhook_url cleared, also clear webhook_secret
      if (webhook_url === null || webhook_url === '') {
        fields.webhookUrl = null
        fields.webhookSecret = null
      }
    } else {
      // Direct LLM mode: clear webhook fields
      if (model_type !== undefined) {
        fields.webhookUrl = null
        fields.webhookSecret = null
      }
    }

    const agent = updateAgent(id, fields)
    return { agent }
  })

  // ─── DELETE /api/agents/:id ───
  app.delete('/api/agents/:id', {
    preHandler: [verifyJWT],
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
      },
    },
  }, async (request, reply) => {
    const { id } = request.params
    const ownerId = findAgentOwner(id)
    if (ownerId === undefined) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Agent 不存在' })
    }
    if (ownerId !== request.user.id) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: '无权操作此 Agent' })
    }

    softDeleteAgent(id)
    return reply.code(204).send()
  })

  // ─── POST /api/agents/:id/rotate-token ───
  app.post('/api/agents/:id/rotate-token', {
    preHandler: [verifyJWT],
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
      },
    },
  }, async (request, reply) => {
    const { id } = request.params
    const ownerId = findAgentOwner(id)
    if (ownerId === undefined) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Agent 不存在' })
    }
    if (ownerId !== request.user.id) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: '无权操作此 Agent' })
    }

    const existing = findAgentById(id)
    if (existing.is_deleted) {
      return reply.code(410).send({ error: 'GONE', message: 'Agent 已被删除' })
    }

    const rawToken = randomBytes(32).toString('hex')
    const tokenHash = sha256(rawToken)
    updateAgentToken(id, tokenHash)

    return { raw_token: rawToken }
  })
}
