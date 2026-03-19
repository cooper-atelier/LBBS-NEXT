import config from '../config.js'
import {
  claimPendingJobs, getJobWithAgent, updateJobStatus,
  resetJobToPending, postSystemMessage, createAgentLog,
} from '../db/queries.js'
import { callOpenAI } from './providers/openai.js'
import { callAnthropic } from './providers/anthropic.js'
import { callWebhook } from './providers/webhook.js'

async function processJob(enrichedJob) {
  // Check if max attempts exceeded (attempts was already incremented by claimPendingJobs)
  if (enrichedJob.attempts > config.MAX_JOB_ATTEMPTS) {
    updateJobStatus(enrichedJob.id, 'failed', 'Max attempts exceeded')
    createAgentLog(enrichedJob.agent_id, enrichedJob.id, 'failed', null, 'Max attempts exceeded')

    // System Bot error message in correct thread position
    postSystemMessage(
      enrichedJob.post_id,
      enrichedJob.comment_id ?? null,
      `⚠️ @${enrichedJob.agent_name} 暂时无响应，已放弃重试。`
    )
    return
  }

  try {
    switch (enrichedJob.model_type) {
      case 'openai':
        await callOpenAI(enrichedJob)
        break
      case 'anthropic':
        await callAnthropic(enrichedJob)
        break
      case 'custom_webhook':
        await callWebhook(enrichedJob)
        break
      default:
        throw new Error(`Unknown model_type: ${enrichedJob.model_type}`)
    }
  } catch (err) {
    // Reset to pending for retry (claimPendingJobs will increment attempts next time)
    resetJobToPending(enrichedJob.id, err.message)
    createAgentLog(enrichedJob.agent_id, enrichedJob.id, 'error', null, err.message)
  }
}

// Backpressure-safe worker: while-loop with sleep instead of setInterval
// Ensures "claim → process → wait → claim" linear flow, no overlapping polls
let isRunning = false

export async function startWorker(intervalMs = config.QUEUE_POLL_INTERVAL_MS) {
  if (isRunning) return
  isRunning = true

  while (isRunning) {
    try {
      const jobs = claimPendingJobs(config.QUEUE_CLAIM_LIMIT)
      if (jobs.length > 0) {
        // Process batch with bounded concurrency via Promise.allSettled
        const tasks = jobs.map(job => {
          const enrichedJob = getJobWithAgent(job.id)
          if (!enrichedJob) {
            updateJobStatus(job.id, 'failed', 'Job enrichment failed')
            return Promise.resolve()
          }
          return processJob(enrichedJob)
        })
        await Promise.allSettled(tasks)
      }
    } catch (err) {
      console.error('Worker poll error:', err)
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

export function stopWorker() {
  isRunning = false
}
