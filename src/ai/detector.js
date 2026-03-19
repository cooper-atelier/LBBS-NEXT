const MENTION_PATTERN = /@([a-zA-Z0-9_\u4e00-\u9fff]+)/g

export const AGENT_NAME_PATTERN = /^[a-zA-Z0-9_\u4e00-\u9fff]+$/
export const AGENT_NAME_PATTERN_JS = '^[a-zA-Z0-9_\\u4e00-\\u9fff]+$'

export function extractMentions(text) {
  return [...new Set([...text.matchAll(MENTION_PATTERN)].map(m => m[1]))]
}

export function extractMentionsWithContext(text) {
  const seen = new Map()
  for (const m of text.matchAll(MENTION_PATTERN)) {
    if (seen.has(m[1])) continue
    const start = Math.max(0, m.index - 50)
    const end = Math.min(text.length, m.index + m[0].length + 100)
    seen.set(m[1], { name: m[1], context: text.slice(start, end) })
  }
  return [...seen.values()]
}
