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
