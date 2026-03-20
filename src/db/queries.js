import { getDb } from './init.js'

// ─── Helpers ───

export function serializeTimestamps(row) {
  if (!row) return row
  const out = { ...row }
  for (const key of ['created_at', 'updated_at']) {
    if (typeof out[key] === 'number') {
      out[key] = new Date(out[key] * 1000).toISOString()
    }
  }
  return out
}

function serializeMany(rows) {
  return rows.map(serializeTimestamps)
}

// ─── Users ───

export function createUser(username, email, passwordHash) {
  const db = getDb()
  const stmt = db.prepare(`
    INSERT INTO users (username, email, password_hash)
    VALUES (?, ?, ?)
  `)
  const result = stmt.run(username, email, passwordHash)
  return result.lastInsertRowid
}

export function findUserByUsername(username) {
  const db = getDb()
  return db.prepare(`
    SELECT id, username, email, password_hash, role, avatar_url, bio,
           token_version, is_active, created_at, updated_at
    FROM users WHERE username = ?
  `).get(username)
}

export function findUserByEmail(email) {
  const db = getDb()
  return db.prepare(`
    SELECT id, username, email, role, avatar_url, bio,
           is_active, created_at, updated_at
    FROM users WHERE email = ?
  `).get(email)
}

export function findUserById(id) {
  const db = getDb()
  const row = db.prepare(`
    SELECT id, username, email, role, avatar_url, bio, created_at, updated_at
    FROM users WHERE id = ?
  `).get(id)
  return serializeTimestamps(row)
}

export function findUserByIdInternal(id) {
  const db = getDb()
  return db.prepare(`
    SELECT id, username, email, role, avatar_url, bio,
           token_version, is_active, created_at, updated_at
    FROM users WHERE id = ?
  `).get(id)
}

export function updateUserProfile(id, { avatarUrl, bio }) {
  const db = getDb()
  const stmt = db.prepare(`
    UPDATE users
    SET avatar_url = COALESCE(?, avatar_url),
        bio = COALESCE(?, bio),
        updated_at = unixepoch()
    WHERE id = ?
  `)
  stmt.run(avatarUrl ?? null, bio ?? null, id)
  return findUserById(id)
}

export function incrementTokenVersion(id) {
  const db = getDb()
  db.prepare(`
    UPDATE users SET token_version = token_version + 1, updated_at = unixepoch()
    WHERE id = ?
  `).run(id)
}

// ─── Boards ───

export function createBoard(name, description, createdBy) {
  const db = getDb()
  const result = db.prepare(`
    INSERT INTO boards (name, description, created_by)
    VALUES (?, ?, ?)
  `).run(name, description || null, createdBy)
  return findBoardById(result.lastInsertRowid)
}

export function listBoards() {
  const db = getDb()
  const rows = db.prepare(`
    SELECT id, name, description, created_by, is_active, created_at
    FROM boards WHERE is_active = 1
    ORDER BY id ASC
  `).all()
  return serializeMany(rows)
}

export function findBoardById(id) {
  const db = getDb()
  const row = db.prepare(`
    SELECT id, name, description, created_by, is_active, created_at
    FROM boards WHERE id = ?
  `).get(id)
  return serializeTimestamps(row)
}

// ─── Posts ───

export function createPost(boardId, authorId, title, content, agentId = null) {
  const db = getDb()
  const result = db.prepare(`
    INSERT INTO posts (board_id, author_id, title, content, agent_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(boardId, authorId, title, content, agentId)
  return findPostById(result.lastInsertRowid)
}

// Cursor pagination by id DESC (creation order).
// Trade-off: no bump-on-reply. Add last_replied_at + composite cursor if needed.
export function listPostsByBoard(boardId, { cursor = null, limit = 20 } = {}) {
  const db = getDb()
  const rows = db.prepare(`
    SELECT p.id, p.board_id, p.author_id, p.agent_id, p.title, p.content,
           p.created_at, p.updated_at,
           u.username AS author_username, u.avatar_url AS author_avatar,
           a.name AS agent_name
    FROM posts p
    JOIN users u ON u.id = p.author_id
    LEFT JOIN agents a ON a.id = p.agent_id
    WHERE p.board_id = ? AND p.is_deleted = 0
      AND (? IS NULL OR p.id < ?)
    ORDER BY p.id DESC
    LIMIT ?
  `).all(boardId, cursor, cursor, limit + 1)

  const hasMore = rows.length > limit
  const posts = serializeMany(hasMore ? rows.slice(0, limit) : rows)
  const nextCursor = hasMore ? posts[posts.length - 1].id : null

  return { posts, nextCursor }
}

export function findPostById(id) {
  const db = getDb()
  const row = db.prepare(`
    SELECT p.id, p.board_id, p.author_id, p.agent_id, p.title, p.content,
           p.is_deleted, p.created_at, p.updated_at,
           u.username AS author_username, u.avatar_url AS author_avatar,
           a.name AS agent_name
    FROM posts p
    JOIN users u ON u.id = p.author_id
    LEFT JOIN agents a ON a.id = p.agent_id
    WHERE p.id = ?
  `).get(id)
  return serializeTimestamps(row)
}

export function updatePost(id, { title, content }) {
  const db = getDb()
  db.prepare(`
    UPDATE posts
    SET title = COALESCE(?, title),
        content = COALESCE(?, content),
        updated_at = unixepoch()
    WHERE id = ? AND is_deleted = 0
  `).run(title ?? null, content ?? null, id)
  return findPostById(id)
}

export function softDeletePost(id) {
  const db = getDb()
  db.prepare(`
    UPDATE posts SET is_deleted = 1, updated_at = unixepoch() WHERE id = ?
  `).run(id)
}

export function findPostOwner(id) {
  const db = getDb()
  const row = db.prepare(`
    SELECT author_id FROM posts WHERE id = ?
  `).get(id)
  return row ? row.author_id : null
}

// ─── Comments ───

export function createComment(postId, authorId, content, parentId = null, agentId = null) {
  const db = getDb()
  const txn = db.transaction(() => {
    // Nesting check inside transaction to prevent race conditions
    if (parentId !== null) {
      const parent = db.prepare('SELECT parent_id, post_id FROM comments WHERE id = ?').get(parentId)
      if (!parent) throw Object.assign(new Error('父评论不存在'), { code: 'NOT_FOUND' })
      if (parent.post_id !== postId) throw Object.assign(new Error('父评论不属于此帖子'), { code: 'INVALID_PARENT' })
      if (parent.parent_id !== null) throw Object.assign(new Error('评论最多支持两层嵌套'), { code: 'NESTING_LIMIT' })
    }
    return db.prepare(`
      INSERT INTO comments (post_id, author_id, content, parent_id, agent_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(postId, authorId, content, parentId, agentId)
  })
  const result = txn()
  return findCommentById(result.lastInsertRowid)
}

export function listCommentsByPost(postId) {
  const db = getDb()
  const rows = db.prepare(`
    SELECT c.id, c.post_id, c.author_id, c.agent_id, c.parent_id,
           c.content, c.is_deleted, c.created_at,
           u.username AS author_username, u.avatar_url AS author_avatar,
           a.name AS agent_name
    FROM comments c
    JOIN users u ON u.id = c.author_id
    LEFT JOIN agents a ON a.id = c.agent_id
    WHERE c.post_id = ?
    ORDER BY c.id ASC
  `).all(postId)
  return serializeMany(rows)
}

export function findCommentById(id) {
  const db = getDb()
  const row = db.prepare(`
    SELECT c.id, c.post_id, c.author_id, c.agent_id, c.parent_id,
           c.content, c.is_deleted, c.created_at,
           u.username AS author_username, u.avatar_url AS author_avatar,
           a.name AS agent_name
    FROM comments c
    JOIN users u ON u.id = c.author_id
    LEFT JOIN agents a ON a.id = c.agent_id
    WHERE c.id = ?
  `).get(id)
  return serializeTimestamps(row)
}

export function updateComment(id, content) {
  const db = getDb()
  db.prepare(`
    UPDATE comments SET content = ? WHERE id = ? AND is_deleted = 0
  `).run(content, id)
  return findCommentById(id)
}

export function softDeleteComment(id) {
  const db = getDb()
  db.prepare(`
    UPDATE comments SET is_deleted = 1 WHERE id = ?
  `).run(id)
}

export function findCommentOwner(id) {
  const db = getDb()
  const row = db.prepare(`
    SELECT author_id FROM comments WHERE id = ?
  `).get(id)
  return row ? row.author_id : null
}

// ─── Agents ───

export function createAgent(name, ownerId, tokenHash, { apiKeyEnc, webhookUrl, webhookSecret, modelType, modelName, systemPrompt, baseUrl }) {
  const db = getDb()
  const result = db.prepare(`
    INSERT INTO agents (name, owner_id, token, api_key_enc, webhook_url, webhook_secret, base_url, model_type, model_name, system_prompt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, ownerId, tokenHash, apiKeyEnc || null, webhookUrl || null, webhookSecret || null, baseUrl || null, modelType, modelName || null, systemPrompt || null)
  return findAgentById(result.lastInsertRowid)
}

export function findAgentById(id) {
  const db = getDb()
  const row = db.prepare(`
    SELECT id, name, owner_id, model_type, model_name, system_prompt,
           webhook_url, base_url, is_active, is_deleted, created_at, updated_at
    FROM agents WHERE id = ?
  `).get(id)
  return serializeTimestamps(row)
}

// Internal: includes encrypted fields, for provider use
export function findAgentByIdInternal(id) {
  const db = getDb()
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id)
}

export function findAgentByToken(tokenHash) {
  const db = getDb()
  return db.prepare('SELECT * FROM agents WHERE token = ?').get(tokenHash)
}

export function listAgentsByOwner(ownerId) {
  const db = getDb()
  const rows = db.prepare(`
    SELECT id, name, owner_id, model_type, model_name, system_prompt,
           webhook_url, base_url, is_active, is_deleted, created_at, updated_at
    FROM agents WHERE owner_id = ? AND is_deleted = 0
    ORDER BY id DESC
  `).all(ownerId)
  return serializeMany(rows)
}

export function listPublicAgents() {
  const db = getDb()
  const rows = db.prepare(`
    SELECT id, name, owner_id, model_type, model_name, system_prompt,
           webhook_url, base_url, is_active, is_deleted, created_at, updated_at
    FROM agents WHERE owner_id IS NULL AND is_deleted = 0
    ORDER BY id DESC
  `).all()
  return serializeMany(rows)
}

// Dynamic SQL build — avoids COALESCE trap so nullable fields can be cleared to NULL
export function updateAgent(id, fields) {
  const db = getDb()
  const setClauses = []
  const params = []

  const mapping = {
    name: 'name',
    apiKeyEnc: 'api_key_enc',
    webhookUrl: 'webhook_url',
    webhookSecret: 'webhook_secret',
    baseUrl: 'base_url',
    modelType: 'model_type',
    modelName: 'model_name',
    systemPrompt: 'system_prompt',
    isActive: 'is_active',
  }

  for (const [jsKey, dbCol] of Object.entries(mapping)) {
    if (jsKey in fields) {
      setClauses.push(`${dbCol} = ?`)
      params.push(fields[jsKey] ?? null)
    }
  }

  if (setClauses.length === 0) return findAgentById(id)

  setClauses.push('updated_at = unixepoch()')
  params.push(id)
  db.prepare(`UPDATE agents SET ${setClauses.join(', ')} WHERE id = ?`).run(...params)
  return findAgentById(id)
}

export function softDeleteAgent(id) {
  const db = getDb()
  db.prepare('UPDATE agents SET is_deleted = 1, is_active = 0 WHERE id = ?').run(id)
}

export function updateAgentToken(id, newTokenHash) {
  const db = getDb()
  db.prepare('UPDATE agents SET token = ? WHERE id = ?').run(newTokenHash, id)
}

export function findAgentOwner(id) {
  const db = getDb()
  const row = db.prepare('SELECT owner_id FROM agents WHERE id = ?').get(id)
  return row ? row.owner_id : undefined
}

// ─── Dispatcher ───

// SQL-level permission check: matches agent by name AND (public OR owned by triggeredBy)
export function findAgentForMention(name, triggeredBy) {
  const db = getDb()
  return db.prepare(`
    SELECT * FROM agents
    WHERE name = ?
      AND (owner_id IS NULL OR owner_id = ?)
      AND is_active = 1
      AND is_deleted = 0
  `).get(name, triggeredBy)
}

// Public AI throttle: count recent jobs for same agent+user in last 60s
export function countRecentJobs(agentId, triggeredBy) {
  const db = getDb()
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt FROM job_queue
    WHERE agent_id = ? AND triggered_by = ? AND created_at > unixepoch() - 60
  `).get(agentId, triggeredBy)
  return row.cnt
}

// ─── Job Queue ───

export function enqueueJob(agentId, postId, commentId, triggeredBy, triggerText) {
  const db = getDb()
  const result = db.prepare(`
    INSERT INTO job_queue (agent_id, post_id, comment_id, triggered_by, trigger_text)
    VALUES (?, ?, ?, ?, ?)
  `).run(agentId, postId, commentId, triggeredBy, triggerText)
  return result.lastInsertRowid
}

// Atomic claim: UPDATE...RETURNING prevents duplicate processing on overlapping polls
export function claimPendingJobs(limit = 5) {
  const db = getDb()
  return db.prepare(`
    UPDATE job_queue
    SET status = 'processing', attempts = attempts + 1, updated_at = unixepoch()
    WHERE id IN (
      SELECT id FROM job_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    )
    RETURNING *
  `).all(limit)
}

export function updateJobStatus(id, status, lastError = null) {
  const db = getDb()
  db.prepare(`
    UPDATE job_queue SET status = ?, last_error = ?, updated_at = unixepoch()
    WHERE id = ?
  `).run(status, lastError, id)
}

export function resetJobToPending(id, errorMsg) {
  const db = getDb()
  db.prepare(`
    UPDATE job_queue SET status = 'pending', last_error = ?, updated_at = unixepoch()
    WHERE id = ?
  `).run(errorMsg, id)
}

// For /api/ai/reply anti-spam: find active job for this agent+post
export function findActiveJob(agentId, postId) {
  const db = getDb()
  return db.prepare(`
    SELECT * FROM job_queue
    WHERE agent_id = ? AND post_id = ?
      AND status IN ('processing', 'waiting_reply')
    ORDER BY created_at DESC LIMIT 1
  `).get(agentId, postId)
}

// Enrich job with agent details + post/board context for processing
export function getJobWithAgent(jobId) {
  const db = getDb()
  return db.prepare(`
    SELECT j.*, a.name AS agent_name, a.model_type, a.model_name,
           a.api_key_enc, a.webhook_url, a.webhook_secret, a.base_url,
           a.system_prompt, a.owner_id AS agent_owner_id,
           u.username AS triggered_by_username,
           p.board_id, p.title AS post_title, p.content AS post_content,
           p.author_id AS post_author_id,
           pu.username AS post_author_username,
           b.name AS board_name
    FROM job_queue j
    JOIN agents a ON a.id = j.agent_id
    JOIN users u ON u.id = j.triggered_by
    JOIN posts p ON p.id = j.post_id
    JOIN users pu ON pu.id = p.author_id
    JOIN boards b ON b.id = p.board_id
    WHERE j.id = ?
  `).get(jobId)
}

// Get recent comments for a post as conversation thread context (max 20)
export function getThreadContext(postId, limit = 20) {
  const db = getDb()
  return db.prepare(`
    SELECT c.id, c.parent_id, c.content, c.author_id, c.agent_id, c.is_deleted,
           u.username AS author_username,
           a.name AS agent_name
    FROM comments c
    JOIN users u ON u.id = c.author_id
    LEFT JOIN agents a ON a.id = c.agent_id
    WHERE c.post_id = ?
    ORDER BY c.id DESC
    LIMIT ?
  `).all(postId, limit).reverse()
}

// ─── Agent Logs ───

export function createAgentLog(agentId, jobId, status, latencyMs = null, errorMsg = null) {
  const db = getDb()
  db.prepare(`
    INSERT INTO agent_logs (agent_id, job_id, status, latency_ms, error_msg)
    VALUES (?, ?, ?, ?, ?)
  `).run(agentId, jobId, status, latencyMs, errorMsg)
}

export function listAgentLogs(agentId, limit = 50) {
  const db = getDb()
  const rows = db.prepare(`
    SELECT id, agent_id, job_id, status, latency_ms, error_msg, created_at
    FROM agent_logs WHERE agent_id = ?
    ORDER BY id DESC LIMIT ?
  `).all(agentId, limit)
  return serializeMany(rows)
}

// ─── Admin ───

export function updateUserStatus(id, isActive) {
  const db = getDb()
  const status = isActive ? 1 : 0
  const txn = db.transaction(() => {
    db.prepare('UPDATE users SET is_active = ?, updated_at = unixepoch() WHERE id = ?').run(status, id)
    // Cascade: enable/disable all private agents owned by this user
    db.prepare('UPDATE agents SET is_active = ?, updated_at = unixepoch() WHERE owner_id = ?').run(status, id)
  })
  txn()
  return findUserById(id)
}

// Check if a public agent already uses this name (坑1: namespace collision)
export function findPublicAgentByName(name) {
  const db = getDb()
  return db.prepare('SELECT id FROM agents WHERE name = ? AND owner_id IS NULL AND is_deleted = 0').get(name)
}

// ─── System Messages ───

export function postSystemMessage(postId, parentId, text) {
  const db = getDb()
  // author_id=1 is the hardcoded system user, agent_id=NULL (not an AI agent)
  const result = db.prepare(`
    INSERT INTO comments (post_id, author_id, agent_id, parent_id, content)
    VALUES (?, 1, NULL, ?, ?)
  `).run(postId, parentId, text)
  return findCommentById(result.lastInsertRowid)
}
