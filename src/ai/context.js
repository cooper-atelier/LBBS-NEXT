// Build conversation context for LLM providers
// Transforms enriched job + thread into structured messages

export function buildContextPrompt(job) {
  const lines = []

  lines.push(`[板块: ${job.board_name}]`)
  lines.push(`[帖子: ${job.post_title}]`)
  lines.push(`[发帖人: ${job.post_author_username}]`)
  lines.push('')
  lines.push(job.post_content)

  if (job.thread && job.thread.length > 0) {
    lines.push('')
    lines.push('--- 评论区 ---')
    for (const c of job.thread) {
      const name = c.agent_name
        ? `${c.author_username} [AI: ${c.agent_name}]`
        : c.author_username
      const content = c.is_deleted ? '[此内容已删除]' : c.content
      const indent = c.parent_id ? '  ↳ ' : ''
      lines.push(`${indent}${name}: ${content}`)
    }
  }

  return lines.join('\n')
}

export function buildSystemMessage(job) {
  const agentName = job.agent_name
  const base = job.system_prompt || `你是 ${agentName}，一个 AI 助手。`
  return `${base}\n\n你正在一个留言板的帖子中参与讨论。用户通过 @${agentName} 提及了你。请根据帖子内容和评论区的上下文来回复。回复应简洁、有帮助，直接回应用户的问题或讨论。不要重复帖子标题或板块名称。`
}
