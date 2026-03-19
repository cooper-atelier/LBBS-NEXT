import config from '../config.js'
import { findAgentForMention, countRecentJobs, enqueueJob } from '../db/queries.js'

export function dispatchMentions({ mentions, postId, commentId = null, triggeredBy }) {
  for (const { name, context } of mentions) {
    // 1. SQL-level permission check (architecture decision #4)
    const agent = findAgentForMention(name, triggeredBy)
    if (!agent) continue  // silent discard

    // 2. Public AI throttle (only when owner_id IS NULL)
    if (agent.owner_id === null) {
      const recentCount = countRecentJobs(agent.id, triggeredBy)
      if (recentCount >= config.publicAiRateLimit) continue  // silent discard
    }

    // 3. Enqueue
    enqueueJob(agent.id, postId, commentId, triggeredBy, context)
  }
}
