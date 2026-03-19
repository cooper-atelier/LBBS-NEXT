import { decrypt } from '../../utils/crypto.js'
import { createComment, updateJobStatus, createAgentLog } from '../../db/queries.js'
import config from '../../config.js'

export async function callOpenAI(job) {
  const startTime = Date.now()
  const apiKey = decrypt(job.api_key_enc)

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: job.model_name || 'gpt-4o-mini',
      messages: [
        ...(job.system_prompt ? [{ role: 'system', content: job.system_prompt }] : []),
        { role: 'user', content: job.trigger_text },
      ],
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(config.LLM_TIMEOUT_MS),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`OpenAI API ${response.status}: ${text.slice(0, 200)}`)
  }

  const data = await response.json()
  const content = data.choices?.[0]?.message?.content
  if (!content) throw new Error('OpenAI returned empty response')

  const latencyMs = Date.now() - startTime
  const authorId = job.agent_owner_id ?? config.SYSTEM_USER_ID
  const parentId = job.comment_id ?? null
  createComment(job.post_id, authorId, content, parentId, job.agent_id)

  updateJobStatus(job.id, 'done')
  createAgentLog(job.agent_id, job.id, 'done', latencyMs)
}
