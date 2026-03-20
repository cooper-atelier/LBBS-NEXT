# PROGRESS.md — lbbs-next

## M1: DB Schema + Auth + 基础 CRUD ✅

Completed: 2026-03-19

### Files created (14)

```
package.json, .env.example, .gitignore
src/config.js
src/utils/crypto.js
src/db/migrations/001_init.sql
src/db/init.js
src/db/queries.js
src/middleware/auth.js
src/middleware/rateLimit.js
src/middleware/validate.js
src/api/auth.js
src/api/users.js
src/api/board.js
src/server.js
bin/cli.js
```

### What works

- 7 tables created (users, boards, posts, comments, agents, job_queue, agent_logs)
- System user (id=1) seeded
- Auth: register, login (JWT access+refresh), refresh, logout (token_version revocation)
- System user login blocked
- Users: GET/PATCH /me, GET /:id public profile
- Boards: list (public), create (admin only)
- Posts: create, list (cursor pagination), detail, edit (owner), soft delete (owner/admin)
- Comments: create (2-layer nesting enforced), edit (owner), soft delete (owner/admin)
- Soft delete: hidden from lists, content masked as `[此内容已删除]` in detail views
- Crypto: AES-256-GCM encrypt/decrypt, SHA-256, HMAC-SHA256
- Rate limiting: global 100req/min, login 5req/min
- All Fastify routes have JSON Schema validation with additionalProperties: false

### Post-review hardening

- Added `busy_timeout = 5000` pragma to prevent SQLITE_BUSY under concurrent writes
- All body schemas locked with `additionalProperties: false` (Fastify strips extra fields)
- Comment nesting check moved into DB transaction to prevent race conditions
- Documented accepted trade-offs: single-point logout, refreshToken in body, cursor by id DESC

### Not yet implemented (M2+)

- AI system (detector, dispatcher, queue, providers, agent_api)
- WebSocket (socket.io)
- Agent management API routes
- Admin API routes
- Web frontend (htmx + PicoCSS)
- Docker / npm packaging
- Vitest test suite

---

## M2: AI System (公共 AI + 队列 + 回写) ✅

Completed: 2026-03-19

### Files created (7)

```
src/ai/detector.js
src/ai/dispatcher.js
src/ai/queue.js
src/ai/agent_api.js
src/ai/providers/openai.js
src/ai/providers/anthropic.js
src/ai/providers/webhook.js
```

### Files modified (4)

```
src/config.js          — Added baseUrl, publicAiRateLimit, LLM/Webhook timeouts, queue config
src/db/queries.js      — Added Agent CRUD, dispatcher, job queue, agent logs, system message queries
src/api/board.js       — Integrated detector+dispatcher into POST create post/comment (PATCH untouched)
src/server.js          — Registered agentApiRoutes, start/stop worker in lifecycle
.env.example           — Added BASE_URL, PUBLIC_AI_RATE_LIMIT
```

### What works

- Detector: `extractMentions` / `extractMentionsWithContext` pure functions, shared `AGENT_NAME_PATTERN` constant
- Dispatcher: SQL-level permission check (architecture decision #4), public AI throttle (N req/60s), silent discard on no match
- Queue worker: backpressure-safe while-loop (not setInterval), atomic `UPDATE...RETURNING` claim, `Promise.allSettled` bounded concurrency, retry with max attempts, System Bot error messages on failure
- Providers: OpenAI, Anthropic (direct LLM call, 60s timeout), Webhook (HMAC-SHA256 signing with `webhook_secret`, 10s timeout, `waiting_reply` intermediate state)
- Agent API: `POST /api/ai/reply` with agent bearer token auth, `job_queue` anti-spam check, writes comment as agent
- Agent queries: `updateAgent` uses dynamic SQL building (not COALESCE) so nullable fields can be cleared
- Post/comment creation triggers AI dispatch after 201 response; PATCH edits do NOT trigger AI (decision #9)
- Worker starts after server listen, stops on SIGINT/SIGTERM graceful shutdown

### Design decisions applied from user review

1. Queue worker uses `while` loop + `await sleep` instead of `setInterval` to prevent poll overlap under slow LLM responses
2. `updateAgent` builds SET clauses dynamically instead of COALESCE, allowing nullable fields (webhook_url etc.) to be cleared
3. AI dispatch in board.js wrapped in try-catch to prevent unhandled rejections after response sent
4. Webhook auth flow documented: external systems must store agent_token at creation time for callback auth

### Not yet implemented (M3+)

- Agent management API routes (`/api/agents/*`)
- Admin API routes (`/api/admin/*`)
- WebSocket (socket.io) real-time broadcast
- Web frontend (htmx + PicoCSS)
- Docker / npm packaging
- Vitest test suite

---

## M3: 私有 AI（用户绑定 + 权限校验）✅

Completed: 2026-03-19

### Files created (3)

```
src/api/agents.js
src/api/admin.js
src/db/migrations/002_agents_updated_at.sql
```

### Files modified (3)

```
src/db/queries.js  — Added updateUserStatus (cascade ban), findPublicAgentByName; added updated_at to agent SELECT/UPDATE queries
src/db/init.js     — Runs incremental migrations (002+); agents table now has updated_at column
src/server.js      — Registered agentRoutes and adminRoutes
src/db/migrations/001_init.sql — Added updated_at column to agents table definition
```

### What works

- User agent management: GET /api/agents/mine, POST /api/agents, PATCH /api/agents/:id, DELETE /api/agents/:id, POST /api/agents/:id/rotate-token
- Admin routes: GET/POST/PATCH /api/admin/agents (public agent CRUD), PATCH /api/admin/agents/:id/toggle, PATCH /api/admin/users/:id (ban/unban)
- All routes have Fastify JSON Schema validation with additionalProperties: false
- Agent name validated against AGENT_NAME_PATTERN_JS (consistent with detector.js)
- rawToken + webhookSecret returned only on create and rotate-token — never stored in plaintext
- Ownership checks on all user agent routes; public-only checks on admin agent routes
- Soft delete only (architecture decision #8)

### Pitfalls addressed

1. **坑1 (Namespace Collision)**: POST /api/agents and PATCH /api/agents/:id check `findPublicAgentByName()` — rejects 409 if name collides with a public agent
2. **坑2 (Zombie Logs Route)**: GET /api/agents/:id/logs omitted — agent_logs table has no writers (YAGNI)
3. **坑3 (Ban Bypass)**: `updateUserStatus` uses a transaction to cascade ban/unban to all private agents owned by the user; system user (id=1) protected from banning
4. **坑4 (Config Residue)**: Switching model_type away from custom_webhook auto-clears webhook_url/webhook_secret; clearing webhook_url also clears webhook_secret

### Not yet implemented (M4+)

- WebSocket (socket.io) real-time broadcast
- Web frontend (htmx + PicoCSS)
- Docker / npm packaging
- Vitest test suite

---

## M4: Web 前端（Vanilla SPA + PicoCSS）✅

Completed: 2026-03-19

### Architecture decision: 抛弃 htmx，纯 Vanilla SPA

M4 计划评估后决定不使用 htmx。后端是纯 JSON API，htmx 的核心价值（服务端返回 HTML 片段 → hx-swap）无法发挥。强行引入只会成为死依赖。最终采用 pushState 路由 + fetch JSON + 模板字符串渲染的纯 Vanilla SPA 方案，零前端构建依赖。

### Files created (4)

```
public/index.html       — SPA 外壳：PicoCSS CDN + socket.io + app.js
public/app.js           — 全部前端逻辑（~1460 行）：路由、认证、API 客户端、页面渲染、WebSocket
public/style.css        — PicoCSS 之上的最小覆盖样式（AI 徽章、评论嵌套、动画、移动端适配）
src/ws/socket.js        — Socket.io 服务端：JWT 握手验证、房间隔离
```

### Files modified (7)

```
package.json            — Added @fastify/static, socket.io
src/server.js           — Registered @fastify/static, socket.io init, SPA fallback handler
src/db/queries.js       — LEFT JOIN agents on listCommentsByPost, findPostById, listPostsByBoard (agent_name 展示)
src/api/board.js        — POST create post/comment 后 emit new_post / new_comment
src/ai/agent_api.js     — AI 回写后 emit ai_reply
src/ai/providers/openai.js    — 直连完成后 emit ai_reply
src/ai/providers/anthropic.js — 直连完成后 emit ai_reply
src/ai/queue.js         — System Bot 错误消息后 emit ai_error
```

### What works

- Auth flow: 注册、登录、JWT 自动刷新、登出、过期 token 自动清理
- Board/post 浏览：板块列表、帖子列表（cursor 分页）、帖子详情 + 评论树（2 层嵌套）
- AI 徽章：agent_id 非空时显示 AI 名称标签
- 内容管理：编辑/删除自己的帖子和评论，admin 可删除任意内容
- 实时 WebSocket：new_post、new_comment、ai_reply、ai_error 事件广播与前端渲染
- AI 思考指示器：发送含 @mention 的内容后显示「正在思考中...」直到 ai_reply/ai_error
- 用户资料：查看/编辑头像 URL、简介
- Agent 管理：创建、编辑、启停、轮换 token、软删除；按 model_type 动态显示/隐藏字段
- Admin 面板：公共 AI 管理（CRUD + 启停）、用户管理（封禁/解封）
- CSS 动画：ws-new fade-in、post-content 空白保留、移动端断点适配

### M4 五大坑处理结果

1. **坑1 htmx 身份危机** → ✅ 已解决。完全抛弃 htmx，纯 Vanilla SPA + pushState 路由。后端保持纯 JSON API 不变。
2. **坑2 401 无限死循环** → ✅ 已解决。`api()` 拦截器排除 `path !== '/auth/refresh'`，加 `isRefreshing` 互斥锁防止并发刷新。
3. **坑3 WebSocket 回音室** → ✅ 已解决。`appendCommentFromSocket()` 先查 `document.querySelector('[data-comment-id="${id}"]')`，已存在则跳过。
4. **坑4 XSS 模板字符串** → ✅ 已解决。所有用户生成内容统一经过 `escapeHtml()` 处理。v0.1 不渲染 Markdown，无需 DOMPurify；若未来引入 marked.js 必须同时引入 DOMPurify。
5. **坑5 Agent Logs 诈尸** → ✅ 已解决。前端无「调用日志」Tab，不暴露 `/api/agents/:id/logs` 路由。agent_logs 表保留但无 UI 入口，践行 YAGNI。

### Security hardening

- CSS.escape() 用于 agent name 的 querySelector，防止 CSS 选择器注入
- Bootstrap 时检测过期 token 并自动清除，避免用户卡在无效登录态

### Not yet implemented (M5+)

- Docker + npm 打包 + CLI (`npx lbbs-next start`)
- 安全加固 + 日志 + 测试覆盖
- Markdown 渲染（需同时引入 DOMPurify）
- Agent 调用日志 UI（后端 query 已就绪，待需求明确后开放）
