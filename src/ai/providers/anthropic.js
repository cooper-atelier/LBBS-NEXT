import { decrypt } from '../../utils/crypto.js'
import { createComment, updateJobStatus, createAgentLog } from '../../db/queries.js'
import config from '../../config.js'
import { getIo } from '../../ws/socket.js'
import { buildContextPrompt, buildSystemMessage } from '../context.js'

export async function callAnthropic(job) {
  const startTime = Date.now()
  const apiKey = decrypt(job.api_key_enc)
  const baseUrl = (job.base_url || 'https://api.anthropic.com/v1').replace(/\/+$/, '')

  const systemMsg = buildSystemMessage(job)
  const contextPrompt = buildContextPrompt(job)

  const response = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: job.model_name || 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: systemMsg,
      messages: [{ role: 'user', content: contextPrompt }],
    }),
    signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Anthropic API ${response.status}: ${text.slice(0, 200)}`)
  }

  const data = await response.json()
  const content = data.content?.[0]?.text
  if (!content) throw new Error('Anthropic returned empty response')

  const latencyMs = Date.now() - startTime
  const authorId = job.agent_owner_id ?? config.SYSTEM_USER_ID
  const parentId = job.comment_id ?? null
  const comment = createComment(job.post_id, authorId, content, parentId, job.agent_id)

  updateJobStatus(job.id, 'done')
  createAgentLog(job.agent_id, job.id, 'done', latencyMs)

  const io = getIo()
  if (io) {
    io.to(`board:${job.board_id}`).emit('ai_reply', {
      post_id: job.post_id,
      agent_name: job.agent_name,
      comment,
    })
  }
}
