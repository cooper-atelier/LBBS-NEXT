import { decrypt } from '../../utils/crypto.js'
import { createComment, updateJobStatus, createAgentLog } from '../../db/queries.js'
import config from '../../config.js'

export async function callAnthropic(job) {
  const startTime = Date.now()
  const apiKey = decrypt(job.api_key_enc)

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: job.model_name || 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      ...(job.system_prompt ? { system: job.system_prompt } : {}),
      messages: [{ role: 'user', content: job.trigger_text }],
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
  createComment(job.post_id, authorId, content, parentId, job.agent_id)

  updateJobStatus(job.id, 'done')
  createAgentLog(job.agent_id, job.id, 'done', latencyMs)
}
