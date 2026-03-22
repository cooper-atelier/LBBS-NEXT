# macro_plan.md — lbbs-next 逐阶段实施计划

> 这份文件是给 AI 编程助手执行用的任务计划。
> 每个 Phase 是独立可验证的，完成后再进入下一个。
> 宏观约束见 **CLAUDE.md**，完整需求见 **PRD.md**。

---

## 执行原则

- 每个 Phase 完成后，运行该 Phase 的验收测试，通过再继续
- 遇到与 CLAUDE.md 架构决策冲突的情况，以 CLAUDE.md 为准
- Phase 内的任务顺序是有依赖关系的，不要乱序执行

---

## Phase 1：数据库初始化 + 认证系统

**目标**：多用户注册登录跑通，JWT 可刷新可吊销

### 1.1 创建文件

```
src/config.js
src/db/init.js
src/db/queries.js（先写 users 相关查询）
src/middleware/auth.js
src/middleware/rateLimit.js
src/api/auth.js
src/server.js（最小化版本，只注册 auth 路由）
bin/cli.js（只实现 init 和 start）
```

### 1.2 db/init.js 要点

建表顺序必须遵守外键依赖：`users → boards → posts → comments → agents → job_queue → agent_logs`

```javascript
// 幂等：所有建表语句用 CREATE TABLE IF NOT EXISTS
// 建表完成后立即插入系统保留账户（硬编码 id=1）
db.prepare(`
  INSERT OR IGNORE INTO users (id, username, email, password_hash, role)
  VALUES (1, 'system', 'system@localhost', 'NO_LOGIN_ALLOWED', 'admin')
`).run()

// ⚠️ SQLite 外键默认关闭，必须手动开启
db.pragma('foreign_keys = ON')
db.pragma('journal_mode = WAL')  // 提升并发读性能
```

完整 Schema 见 PRD.md §4.1。注意 `agents` 表需包含 `webhook_secret` 字段。

### 1.3 auth.js 要点

**密码**：bcrypt cost=12，哈希存 `users.password_hash`

**JWT 双 Token**：
```javascript
// 签发时把 token_version 写进 payload
const accessToken  = jwt.sign({ sub: user.id, ver: user.token_version }, JWT_SECRET,  { expiresIn: '15m' })
const refreshToken = jwt.sign({ sub: user.id, ver: user.token_version }, JWT_REFRESH_SECRET, { expiresIn: '7d' })

// 验证 refresh token 时比对数据库的 token_version（吊销机制）
const payload = jwt.verify(token, JWT_REFRESH_SECRET)
const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.sub)
if (user.token_version !== payload.ver) throw new Error('Token revoked')

// 登出/改密时吊销所有旧 Token
db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(userId)
```

**Fastify Schema 示例**（每个路由都要有）：
```javascript
fastify.post('/api/auth/login', {
  schema: {
    body: {
      type: 'object',
      required: ['username', 'password'],
      properties: {
        username: { type: 'string', minLength: 1 },
        password: { type: 'string', minLength: 6 }
      }
    }
  }
}, async (request, reply) => { ... })
```

### 1.4 middleware/auth.js

```javascript
export async function verifyJWT(request, reply) {
  const token = request.headers.authorization?.replace('Bearer ', '')
  if (!token) return reply.code(401).send({ error: 'AUTH_REQUIRED', message: '请先登录' })
  try {
    const payload = jwt.verify(token, config.JWT_SECRET)
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(payload.sub)
    if (!user) return reply.code(401).send({ error: 'AUTH_REQUIRED' })
    request.user = user
  } catch {
    return reply.code(401).send({ error: 'AUTH_REQUIRED', message: 'Token 无效或已过期' })
  }
}

export function requireAdmin(request, reply, done) {
  if (request.user?.role !== 'admin')
    return reply.code(403).send({ error: 'FORBIDDEN', message: '需要管理员权限' })
  done()
}
```

### 1.5 加密工具（src/utils/crypto.js）

```javascript
import { createCipheriv, createDecipheriv, randomBytes, createHash, createHmac } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const SECRET = Buffer.from(process.env.ENCRYPTION_KEY, 'hex')

export function encrypt(plaintext) {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, SECRET, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

export function decrypt(ciphertext) {
  const [ivHex, tagHex, dataHex] = ciphertext.split(':')
  const decipher = createDecipheriv(ALGORITHM, SECRET, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return decipher.update(Buffer.from(dataHex, 'hex')) + decipher.final('utf8')
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

export function hmacSha256(data, secret) {
  return createHmac('sha256', secret).update(data).digest('hex')
}
```

### 1.6 验收标准

```bash
# 全部通过后进入 Phase 2
npm test -- src/api/auth.test.js

# 手动验证
curl -X POST localhost:3000/api/auth/register -d '{"username":"alice","email":"a@a.com","password":"123456"}'
# 返回 201

curl -X POST localhost:3000/api/auth/login -d '{"username":"alice","password":"123456"}'
# 返回 { accessToken, refreshToken }
```

---

## Phase 2：留言板 CRUD

**目标**：发帖/回帖/软删除完整跑通

### 2.1 创建文件

```
src/api/board.js
src/api/users.js
src/api/admin.js（先只实现板块管理）
src/db/queries.js（补充 boards/posts/comments 查询）
```

### 2.2 软删除的两种场景（关键！）

```javascript
// ✅ 场景 A：列表查询（首页、板块帖子列表）
// 直接过滤，不展示已删帖子
db.prepare('SELECT * FROM posts WHERE board_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?')
  .all(boardId, limit, offset)

// ✅ 场景 B：帖子详情（含评论树）
// 不过滤 is_deleted，在 API 层替换内容，保留楼层连贯性
const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId)
const comments = db.prepare('SELECT * FROM comments WHERE post_id = ? ORDER BY created_at ASC').all(postId)
if (post.is_deleted) post.content = '[此内容已删除]'
for (const c of comments) { if (c.is_deleted) c.content = '[此内容已删除]' }

// ❌ 禁止：WHERE is_deleted = 0 后又在 API 层判断 is_deleted（SQL 已过滤，永远进不了 if）
```

### 2.3 PATCH 编辑操作禁止触发 AI（关键！）

```javascript
// src/api/board.js
fastify.patch('/api/posts/:id', { preHandler: [verifyJWT] }, async (request, reply) => {
  // 只更新内容字段，不做任何 AI 相关操作
  const { title, content } = request.body
  db.prepare('UPDATE posts SET title=?, content=?, updated_at=unixepoch() WHERE id=? AND author_id=?')
    .run(title, content, request.params.id, request.user.id)
  // ⚠️ 不调用 detectAndEnqueueAI，编辑不触发 AI
  return reply.code(200).send({ ok: true })
})
```

### 2.4 时间戳序列化

```javascript
// queries.js 返回的原始数据是整数秒
{ created_at: 1718000000 }

// API 响应时转为 ISO 8601
function serializePost(row) {
  return {
    ...row,
    created_at: new Date(row.created_at * 1000).toISOString(),
    updated_at: new Date(row.updated_at * 1000).toISOString()
  }
}
```

### 2.5 验收标准

```bash
npm test -- src/api/board.test.js

# 手动验证：发帖 → 软删除 → 详情仍可见 [此内容已删除]
```

---

## Phase 3：AI 系统核心（detector + dispatcher + queue）

**目标**：@mention 被正确解析、入队、异步处理（先不实现 LLM 调用，用 mock）

### 3.1 创建文件

```
src/ai/detector.js
src/ai/dispatcher.js
src/db/queries.js（补充 agents/job_queue 查询）
```

### 3.2 detector.js — 纯函数，不查 DB

```javascript
// src/ai/detector.js
const MENTION_PATTERN = /@([a-zA-Z0-9_\u4e00-\u9fff]+)/g

export function extractMentions(text) {
  return [...new Set([...text.matchAll(MENTION_PATTERN)].map(m => m[1]))]
}

// 同时保留触发上下文，供 Webhook payload 使用
export function extractMentionsWithContext(text) {
  const matches = []
  for (const m of text.matchAll(MENTION_PATTERN)) {
    const start = Math.max(0, m.index - 50)
    const end   = Math.min(text.length, m.index + 100)
    matches.push({ name: m[1], context: text.slice(start, end) })
  }
  return [...new Map(matches.map(x => [x.name, x])).values()]  // 去重，保留第一次上下文
}
```

### 3.3 dispatcher.js — 权限校验 + 公共AI节流 + 入队

```javascript
// src/ai/dispatcher.js
export function dispatchMentions({ mentions, postId, commentId = null, triggeredBy }) {
  for (const { name, context } of mentions) {

    // 1. 权限校验（在 SQL 层完成）
    const agent = db.prepare(`
      SELECT * FROM agents
      WHERE name = ?
        AND (owner_id IS NULL OR owner_id = ?)
        AND is_active = 1
        AND is_deleted = 0
    `).get(name, triggeredBy)
    if (!agent) continue  // 静默丢弃

    // 2. 公共 AI 节流（owner_id IS NULL 时才检查）
    if (agent.owner_id === null) {
      const recentCount = db.prepare(`
        SELECT COUNT(*) AS cnt FROM job_queue
        WHERE agent_id = ? AND triggered_by = ? AND created_at > unixepoch() - 60
      `).get(agent.id, triggeredBy).cnt

      const PUBLIC_AI_RATE_LIMIT = config.publicAiRateLimit ?? 5  // 每分钟上限，默认 5
      if (recentCount >= PUBLIC_AI_RATE_LIMIT) {
        // 静默跳过，不报错（防止暴露节流策略）
        continue
      }
    }

    // 3. 写入队列
    db.prepare(`
      INSERT INTO job_queue (agent_id, post_id, comment_id, triggered_by, trigger_text)
      VALUES (?, ?, ?, ?, ?)
    `).run(agent.id, postId, commentId, triggeredBy, context)
  }
}
```

> `trigger_text` 字段需在 PRD Schema 的 `job_queue` 表中补充（供 Webhook payload 使用）。

### 3.4 queue.js — 原子抓取 + 状态机

```javascript
// src/ai/queue.js

// ✅ 原子抓取：UPDATE + RETURNING，防止轮询重叠时重复处理
function claimPendingJobs(limit = 5) {
  return db.prepare(`
    UPDATE job_queue
    SET status = 'processing', updated_at = unixepoch()
    WHERE id IN (
      SELECT id FROM job_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT ?
    )
    RETURNING *
  `).all(limit)
}

const MAX_ATTEMPTS = 2

async function processJob(job) {
  // 超时策略：直连 LLM 60s，Webhook 只等受理 10s
  const TIMEOUT_MS = job.model_type === 'custom_webhook' ? 10_000 : 60_000

  if (job.attempts >= MAX_ATTEMPTS) {
    db.prepare(`UPDATE job_queue SET status='failed' WHERE id=?`).run(job.id)
    // 报错消息挂在触发源的楼层下
    postSystemMessage({ postId: job.post_id, parentId: job.comment_id ?? null,
      text: `⚠️ System: @${job.agent_name} 暂时无响应，已放弃重试。` })
    return
  }

  try {
    await Promise.race([
      callAgent(job),      // Phase 4 实现
      new Promise((_, r) => setTimeout(() => r(new Error('TIMEOUT')), TIMEOUT_MS))
    ])
    // 直连模式：callAgent 直接写入评论，这里标 done
    // Webhook 模式：callAgent 发出 HTTP 请求，这里标 waiting_reply（在 callAgent 内部完成状态更新）
  } catch (err) {
    db.prepare(`
      UPDATE job_queue SET status='pending', attempts=attempts+1,
      last_error=?, updated_at=unixepoch() WHERE id=?
    `).run(err.message, job.id)
  }
}

// Worker 主循环
export function startWorker(intervalMs = 2000) {
  setInterval(async () => {
    const jobs = claimPendingJobs(5)
    for (const job of jobs) {
      processJob(job).catch(err => console.error('Worker error:', err))
    }
  }, intervalMs)
}

// 系统报错消息写入
function postSystemMessage({ postId, parentId, text }) {
  db.prepare(`
    INSERT INTO comments (post_id, author_id, agent_id, parent_id, content)
    VALUES (?, 1, NULL, ?, ?)
  `).run(postId, parentId, text)
  // author_id=1 是硬编码的系统账户（见 init.js 种子数据）
}
```

### 3.5 发帖路由集成（board.js 补充）

```javascript
// 在 POST /api/boards/:id/posts 路由里
const post = db.prepare(INSERT_POST).run(data)
reply.code(201).send(serializePost(post))  // 立即返回！

// 异步触发（不 await，不阻塞）
const mentions = extractMentionsWithContext(data.content)
if (mentions.length > 0) {
  dispatchMentions({ mentions, postId: post.lastInsertRowid,
    commentId: null, triggeredBy: request.user.id })
}

// ⚠️ PATCH 路由里完全不调用 dispatchMentions
```

### 3.6 验收标准

```bash
npm test -- src/ai/detector.test.js src/ai/dispatcher.test.js

# detector 测试用例必须覆盖：
# - 单个 @mention
# - 多个 @mention 去重
# - 含中文的 @mention
# - name 含空格的无效格式（不应匹配）

# dispatcher 测试用例必须覆盖：
# - 私有 AI 不响应非 owner 的 @
# - 已软删除的 Agent 不响应
# - 公共 AI 触发超过频率限制被静默跳过
# - 编辑帖子（PATCH）不触发入队
```

---

## Phase 4：AI Provider 实现 + 回写接口

**目标**：完整的 AI 调用链跑通，含直连和 Webhook 两种模式

### 4.1 创建文件

```
src/ai/providers/openai.js
src/ai/providers/anthropic.js
src/ai/providers/webhook.js
src/ai/agent_api.js
src/api/agents.js
```

### 4.2 providers/webhook.js — 签名与 Payload

```javascript
// src/ai/providers/webhook.js
import { hmacSha256 } from '../utils/crypto.js'

export async function callWebhook(job, agent) {
  const payload = {
    event:        'ai_mention',
    agent_name:   agent.name,
    post_id:      job.post_id,
    comment_id:   job.comment_id ?? null,
    trigger_text: job.trigger_text,
    author:       { id: job.triggered_by_username, username: job.triggered_by_username },
    reply_to:     { type: job.comment_id ? 'comment' : 'post',
                    id: job.comment_id ?? job.post_id },
    callback_url: `${config.baseUrl}/api/ai/reply`
  }

  const body = JSON.stringify(payload)

  // 签名密钥使用 webhook_secret（独立字段，非 token 哈希）
  // token 只存哈希，无法还原为明文用于 HMAC，必须单独存 webhook_secret
  const webhookSecret = agent.webhook_secret_enc
    ? decrypt(agent.webhook_secret_enc)   // 如果加密存储则先解密
    : agent.webhook_secret                // 或明文存储（简单场景）

  const signature = hmacSha256(body, webhookSecret)

  const res = await fetch(agent.webhook_url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-LBBS-Signature': signature },
    body,
    signal:  AbortSignal.timeout(10_000)  // 只等受理，不等 AI 生成
  })

  if (!res.ok) throw new Error(`Webhook returned ${res.status}`)

  // ⚠️ Webhook 受理成功后，状态改为 waiting_reply，不是 done
  // done 的时机是外部 AI 调用 POST /api/ai/reply 成功后
  db.prepare(`UPDATE job_queue SET status='waiting_reply', updated_at=unixepoch() WHERE id=?`)
    .run(job.id)
}
```

### 4.3 agent_api.js — 防刷屏回写接口

```javascript
// src/ai/agent_api.js
export async function registerAgentApi(fastify) {
  fastify.post('/api/ai/reply', {
    schema: {
      body: {
        type: 'object',
        required: ['post_id', 'target_type', 'target_id', 'content'],
        properties: {
          post_id:     { type: 'integer' },
          target_type: { type: 'string', enum: ['post', 'comment'] },
          target_id:   { type: 'integer' },
          content:     { type: 'string', minLength: 1, maxLength: 10000 }
        }
      }
    }
  }, async (request, reply) => {
    // 1. 验证 Agent Token
    const raw = request.headers.authorization?.replace('Bearer ', '')
    if (!raw) return reply.code(401).send({ error: 'AUTH_REQUIRED' })
    const agent = db.prepare('SELECT * FROM agents WHERE token = ?').get(sha256(raw))
    if (!agent || agent.is_deleted) return reply.code(401).send({ error: 'AUTH_REQUIRED' })

    const { post_id, target_type, target_id, content } = request.body

    // 2. ⚠️ 防刷屏：反查 job_queue，确认存在合法任务
    //    Webhook 模式查 waiting_reply，直连模式查 processing
    const job = db.prepare(`
      SELECT * FROM job_queue
      WHERE agent_id = ? AND post_id = ?
        AND status IN ('processing', 'waiting_reply')
      ORDER BY created_at DESC LIMIT 1
    `).get(agent.id, post_id)

    if (!job) return reply.code(403).send({
      error: 'FORBIDDEN', message: '未找到对应的待处理任务，回写被拒绝'
    })

    // 3. 写入评论
    //    author_id = agent 主人的 owner_id（公共AI为 NULL，用 1 兜底或专用账户）
    const authorId = agent.owner_id ?? 1
    const parentId = target_type === 'comment' ? target_id : null
    const result = db.prepare(`
      INSERT INTO comments (post_id, author_id, agent_id, parent_id, content)
      VALUES (?, ?, ?, ?, ?)
    `).run(post_id, authorId, agent.id, parentId, content)

    // 4. 标记任务完成
    db.prepare(`UPDATE job_queue SET status='done', updated_at=unixepoch() WHERE id=?`).run(job.id)

    // 5. 广播 WebSocket
    io.to(`board:${job.board_id ?? 0}`).emit('ai_reply', {
      post_id, target_type, target_id,
      agent_name: agent.name, content,
      comment_id: result.lastInsertRowid
    })

    return reply.code(201).send({ ok: true })
  })
}
```

### 4.4 api/agents.js — 用户管理私有 AI

关键点：

```javascript
// 创建 Agent 时生成 webhook_secret
const rawToken = randomBytes(32).toString('hex')
const tokenHash = sha256(rawToken)
const webhookSecret = randomBytes(24).toString('hex')  // 独立签名密钥

db.prepare(`
  INSERT INTO agents (name, owner_id, token, api_key_enc, webhook_url, webhook_secret, model_type, ...)
  VALUES (?, ?, ?, ?, ?, ?, ?, ...)
`).run(name, userId, tokenHash, apiKeyEnc, webhookUrl, webhookSecret, modelType)

// rawToken 和 webhookSecret 只在创建响应里返回一次
return reply.code(201).send({ agent: { id, name, ... }, rawToken, webhookSecret })

// Agent name 正则校验（必须与 detector.js 一致）
// 在 Fastify schema 里用 pattern: '^[a-zA-Z0-9_\\u4e00-\\u9fff]+$'

// DELETE 是软删除
fastify.delete('/api/agents/:id', async (request, reply) => {
  db.prepare(`UPDATE agents SET is_deleted=1 WHERE id=? AND owner_id=?`)
    .run(request.params.id, request.user.id)
  return reply.code(200).send({ ok: true })
})
```

### 4.5 验收标准

```bash
npm test -- src/ai/agent_api.test.js tests/e2e/ai-mention.test.js

# E2E 用例必须覆盖：
# - 发帖含 @公共AI → job 入队 → 直连 LLM → 收到 ai_reply WS 事件
# - 发帖含 @私有AI → owner 触发成功，非 owner 被忽略
# - Webhook 模式：BBS 标记 waiting_reply → 外部 AI 调用 /api/ai/reply → 标记 done
# - 持 token 直接调用 /api/ai/reply（无 job）→ 403 FORBIDDEN
# - 超时重试 2 次后：System Bot 报错挂在正确楼层
```

---

## Phase 5：Web 前端 + CLI + Docker

**目标**：浏览器可用，`npx lbbs-next start` 一行跑通

### 5.1 前端原则（无构建）

- 只用 htmx + PicoCSS，所有 JS 写在 `public/app.js`，不引入 npm 包
- 禁止 React/Vue/Vite/Webpack
- AI 回复渲染：检查 `comment.agent_id !== null`，显示 AI 名称标签

```javascript
// public/app.js 的 WebSocket 部分
const socket = io({ auth: { token: localStorage.getItem('accessToken') } })
socket.emit('join_board', { board_id: currentBoardId })
socket.on('ai_reply', ({ post_id, agent_name, content, comment_id }) => {
  appendComment(post_id, { content, agent_name, isAI: true })
})
socket.on('ai_error', ({ post_id, agent_name, message }) => {
  appendComment(post_id, { content: `⚠️ ${message}`, isSystem: true })
})
```

### 5.2 CLI（bin/cli.js）

```bash
npx lbbs-next init            # 生成 .env、建表、插入种子
npx lbbs-next start           # 启动服务
npx lbbs-next create-admin    # 交互式创建管理员
npx lbbs-next add-ai          # 交互式添加全局公共 AI
npx lbbs-next status          # 显示运行状态（队列积压、在线人数）
npx lbbs-next backup          # 备份 bbs.db
```

### 5.3 Dockerfile

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "bin/cli.js", "start"]
```

### 5.4 验收标准

```bash
docker build -t lbbs-next .
docker run -p 3000:3000 -v $(pwd)/data:/app/data lbbs-next
# 浏览器打开 localhost:3000 能完成：注册 → 登录 → 发帖 → @AI → 收到回复
```

---

## Phase 6：安全加固 + 测试覆盖

**目标**：可交付给他人使用的健壮版本

### 6.1 速率限制配置

```javascript
// src/middleware/rateLimit.js
await fastify.register(import('@fastify/rate-limit'), {
  global: true,
  max: 100,
  timeWindow: '1 minute'
})

// 登录接口单独限制
fastify.post('/api/auth/login', {
  config: { rateLimit: { max: 5, timeWindow: '1 minute' } }
}, handler)
```

### 6.2 CORS 配置

```javascript
await fastify.register(import('@fastify/cors'), {
  origin: config.ALLOWED_ORIGINS.split(',')
})
```

### 6.3 测试覆盖率要求

| 模块 | 最低覆盖率 | 关键用例 |
|------|----------|---------|
| `ai/detector.js` | 100% | 各种 mention 格式、边界 |
| `ai/dispatcher.js` | 90% | 权限矩阵、节流、软删除 |
| `api/auth.js` | 90% | 注册/登录/吊销/刷新 |
| `ai/agent_api.js` | 90% | 防刷屏校验、状态机流转 |

### 6.4 回归测试清单（手动 or 自动）

- [ ] 用户 A 无法触发用户 B 的私有 AI
- [ ] 软删除的 Agent 不响应 @mention
- [ ] PATCH 编辑帖子后 AI 没有新回复
- [ ] Webhook 受理后 job 状态为 `waiting_reply`，回写后变 `done`
- [ ] 直接调用 `/api/ai/reply` 无 job 记录 → 403
- [ ] LLM 超时 → 重试 2 次 → System Bot 报错在正确楼层
- [ ] 持 token 每分钟对公共 AI 发 6 次 → 第 6 次被静默丢弃
- [ ] 删除 Agent → 历史帖子仍显示 AI 标签（非主人发言）

---

## 附录：关键常量速查

```javascript
// src/config.js
export const config = {
  PORT:               process.env.PORT ?? 3000,
  HOST:               process.env.HOST ?? '0.0.0.0',
  DATA_DIR:           process.env.DATA_DIR ?? './data',
  JWT_SECRET:         process.env.JWT_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  ENCRYPTION_KEY:     process.env.ENCRYPTION_KEY,
  ALLOWED_ORIGINS:    process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000',
  LOG_LEVEL:          process.env.LOG_LEVEL ?? 'info',
  baseUrl:            process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
  publicAiRateLimit:  parseInt(process.env.PUBLIC_AI_RATE_LIMIT ?? '5')
}

// 启动时校验必填项
const REQUIRED = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'ENCRYPTION_KEY']
for (const key of REQUIRED) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`)
}
```

```javascript
// job_queue status 枚举（全项目唯一来源）
export const JOB_STATUS = {
  PENDING:       'pending',
  PROCESSING:    'processing',
  WAITING_REPLY: 'waiting_reply',  // Webhook 模式专用中间态
  DONE:          'done',
  FAILED:        'failed'
}
```

```javascript
// Agent 名称正则（detector.js 与 Fastify schema 共用同一个常量）
export const AGENT_NAME_PATTERN    = /^[a-zA-Z0-9_\u4e00-\u9fff]+$/
export const AGENT_NAME_PATTERN_JS = '^[a-zA-Z0-9_\\u4e00-\\u9fff]+$'  // 用于 JSON Schema
```
