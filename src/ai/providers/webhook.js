import { hmacSha256 } from '../../utils/crypto.js'
import { updateJobStatus, createAgentLog } from '../../db/queries.js'
import config from '../../config.js'

export async function callWebhook(job) {
  const startTime = Date.now()

  const payload = {
    event: 'ai_mention',
    agent_name: job.agent_name,
    post_id: job.post_id,
    comment_id: job.comment_id ?? null,
    trigger_text: job.trigger_text,
    author: { id: job.triggered_by, username: job.triggered_by_username },
    post: {
      id: job.post_id,
      title: job.post_title,
      content: job.post_content,
      author: { id: job.post_author_id, username: job.post_author_username },
    },
    board: { id: job.board_id, name: job.board_name },
    thread: (job.thread || []).map(c => ({
      id: c.id,
      parent_id: c.parent_id,
      content: c.is_deleted ? '[此内容已删除]' : c.content,
      author: { id: c.author_id, username: c.author_username },
      agent_name: c.agent_name ?? null,
    })),
    reply_to: {
      type: job.comment_id ? 'comment' : 'post',
      id: job.comment_id ?? job.post_id,
    },
    callback_url: `${config.baseUrl}/api/ai/reply`,
  }

  const body = JSON.stringify(payload)

  // Sign with webhook_secret (independent from token — architecture decision #7)
  const signature = hmacSha256(body, job.webhook_secret)

  const response = await fetch(job.webhook_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-LBBS-Signature': signature,
    },
    body,
    signal: AbortSignal.timeout(config.WEBHOOK_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`Webhook returned ${response.status}`)
  }

  const latencyMs = Date.now() - startTime

  // Webhook accepted — set waiting_reply, NOT done (architecture decision #10)
  updateJobStatus(job.id, 'waiting_reply')
  createAgentLog(job.agent_id, job.id, 'waiting_reply', latencyMs)
}
