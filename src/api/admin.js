import { randomBytes } from 'node:crypto'
import { verifyJWT, requireAdmin } from '../middleware/auth.js'
import { sha256, encrypt } from '../utils/crypto.js'
import { AGENT_NAME_PATTERN_JS } from '../ai/detector.js'
import config from '../config.js'
import {
  listPublicAgents,
  createAgent,
  findAgentById,
  updateAgent,
  findUserById,
  updateUserStatus,
} from '../db/queries.js'

const AGENT_NAME_SCHEMA = { type: 'string', pattern: AGENT_NAME_PATTERN_JS, minLength: 1, maxLength: 32 }
const MODEL_TYPES = ['openai', 'anthropic', 'custom_webhook']

export default async function adminRoutes(app) {
  // All admin routes require JWT + admin role
  app.addHook('preHandler', verifyJWT)
  app.addHook('preHandler', requireAdmin)

  // ─── GET /api/admin/agents ───
  app.get('/api/admin/agents', {
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
  }, async () => {
    const agents = listPublicAgents()
    return { agents }
  })

  // ─── POST /api/admin/agents ───
  app.post('/api/admin/agents', {
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
          base_url: { type: 'string', format: 'uri', maxLength: 500 },
          webhook_url: { type: 'string', format: 'uri', maxLength: 500 },
        },
      },
    },
  }, async (request, reply) => {
    const { name, model_type, model_name, system_prompt, api_key, base_url, webhook_url } = request.body

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
    const finalWebhookUrl = model_type === 'custom_webhook' ? webhook_url : null
    const finalWebhookSecret = model_type === 'custom_webhook' ? webhookSecret : null

    // owner_id = null → public agent
    const agent = createAgent(name, null, tokenHash, {
      apiKeyEnc,
      webhookUrl: finalWebhookUrl,
      webhookSecret: finalWebhookSecret,
      modelType: model_type,
      modelName: model_name || null,
      systemPrompt: system_prompt || null,
      baseUrl: model_type !== 'custom_webhook' ? (base_url || null) : null,
    })

    return reply.code(201).send({
      agent,
      raw_token: rawToken,
      webhook_secret: model_type === 'custom_webhook' ? webhookSecret : undefined,
    })
  })

  // ─── PATCH /api/admin/agents/:id ───
  app.patch('/api/admin/agents/:id', {
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
    const existing = findAgentById(id)
    if (!existing) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Agent 不存在' })
    }
    if (existing.owner_id !== null) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: '此接口仅管理公共 Agent' })
    }
    if (existing.is_deleted) {
      return reply.code(410).send({ error: 'GONE', message: 'Agent 已被删除' })
    }

    const { name, model_type, model_name, system_prompt, api_key, base_url, webhook_url, is_active } = request.body
    const effectiveModelType = model_type || existing.model_type

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
      if (webhook_url !== undefined) fields.webhookUrl = webhook_url || null
      if (webhook_url === null || webhook_url === '') {
        fields.webhookUrl = null
        fields.webhookSecret = null
      }
      if (model_type !== undefined && model_type === 'custom_webhook') {
        fields.baseUrl = null
      }
    } else {
      if (base_url !== undefined) fields.baseUrl = base_url || null
      if (model_type !== undefined) {
        fields.webhookUrl = null
        fields.webhookSecret = null
      }
    }

    const agent = updateAgent(id, fields)
    return { agent }
  })

  // ─── PATCH /api/admin/agents/:id/toggle ───
  app.patch('/api/admin/agents/:id/toggle', {
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
      },
      body: {
        type: 'object',
        required: ['is_active'],
        additionalProperties: false,
        properties: {
          is_active: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params
    const existing = findAgentById(id)
    if (!existing) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'Agent 不存在' })
    }
    if (existing.is_deleted) {
      return reply.code(410).send({ error: 'GONE', message: 'Agent 已被删除' })
    }

    const agent = updateAgent(id, { isActive: request.body.is_active ? 1 : 0 })
    return { agent }
  })

  // ─── PATCH /api/admin/users/:id ───
  app.patch('/api/admin/users/:id', {
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
      },
      body: {
        type: 'object',
        required: ['is_active'],
        additionalProperties: false,
        properties: {
          is_active: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params

    // Block banning the system user
    if (id === config.SYSTEM_USER_ID) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: '不能封禁系统账户' })
    }

    const user = findUserById(id)
    if (!user) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: '用户不存在' })
    }

    // 坑3: Cascade ban — also disables/enables all private agents owned by this user
    const updated = updateUserStatus(id, request.body.is_active)
    return { user: updated }
  })
}
