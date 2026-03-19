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
