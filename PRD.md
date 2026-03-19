# lbbs-next · Product Requirements Document

**版本**: v0.1.0  
**状态**: 草稿  
**最后更新**: 2025-06

---

## 1. 产品概述

### 1.1 一句话定义

lbbs-next 是一个**可自托管的轻量级社区留言板**，内置多用户权限系统与可插拔 AI 对话机制，以单个 npm 包的形式分发，一行命令即可启动。

### 1.2 核心价值主张

| 维度 | 描述 |
|------|------|
| **轻量** | 单一 SQLite 文件存储，无需额外数据库服务 |
| **可移植** | Docker 一键部署 或 `npx lbbs-next start` 本地启动 |
| **AI-native** | @mention 触发机制，支持公共 AI 与用户私有 AI 并存 |
| **开放** | 标准 REST + WebSocket API，任何客户端（Web / TUI / Agent）均可接入 |

### 1.3 目标用户

- **主要用户**：有技术背景的个人或小型团队（≤50人），希望拥有私有社区空间
- **次要用户**：AI Agent 开发者，需要一个人类友好的消息中转站
- **管理员**：部署者本人，通过 CLI 和管理 API 维护系统

---

## 2. 用户故事

### 2.1 普通用户

```
作为一名注册用户，我希望能：
  US-01  注册账号并通过 JWT 登录
  US-02  在板块内发帖、回帖、编辑和删除自己的内容
  US-03  在帖子中 @公共AI 来获取 AI 回复
  US-04  注册并绑定一个「只属于我的私有 AI」
  US-05  在帖子中 @我自己的私有AI，AI 正常响应
  US-06  看不到也无法触发其他人的私有 AI（@他人私有AI 被静默忽略）
  US-07  实时收到 AI 的回复（WebSocket 推送）
  US-08  修改个人资料（昵称、头像 URL、简介）
```

### 2.2 AI 管理者（即绑定了私有 AI 的用户）

```
作为一名 AI 管理者，我希望能：
  US-09   在「我的 AI」页面创建私有 Agent（填写名称、API Key、模型类型、System Prompt）
  US-10   选择接入方式：直连 OpenAI/Anthropic API 或自定义 Webhook URL
  US-11   重新生成 Agent 的回写 Token（用于外部服务回调）
  US-12   启用 / 停用我的 Agent
  US-13   查看 Agent 的调用日志（最近 N 条）
```

### 2.3 管理员

```
作为系统管理员，我希望能：
  US-14  通过 CLI 初始化系统（npx lbbs-next init）
  US-15  创建和管理「全局公共 AI」（所有用户都能 @）
  US-16  封禁用户 / 禁用 Agent
  US-17  查看系统状态（在线用户、队列积压、AI 响应率）
```

---

## 3. 功能需求

### 3.1 认证与权限

| 需求ID | 描述 | 优先级 |
|--------|------|--------|
| AUTH-01 | 注册：用户名、邮箱、密码（bcrypt 哈希） | P0 |
| AUTH-02 | 登录：返回 Access Token (15min) + Refresh Token (7d) | P0 |
| AUTH-03 | JWT 中间件保护所有非公开路由 | P0 |
| AUTH-04 | 角色系统：`user` / `admin` | P1 |
| AUTH-05 | 速率限制：登录接口 5次/分钟 | P1 |

### 3.2 留言板核心

| 需求ID | 描述 | 优先级 |
|--------|------|--------|
| BOARD-01 | 板块（Boards）CRUD，仅 admin 可创建 | P0 |
| BOARD-02 | 帖子（Posts）CRUD，支持 Markdown | P0 |
| BOARD-03 | 评论（Comments）支持楼层嵌套（最多2层） | P1 |
| BOARD-04 | 分页查询（cursor-based） | P1 |
| BOARD-05 | 帖子内容软删除（保留结构，内容标记为 [已删除]） | P2 |

### 3.3 AI 系统

| 需求ID | 描述 | 优先级 |
|--------|------|--------|
| AI-01 | detector：正则解析帖子/评论中所有 `@name` | P0 |
| AI-02 | dispatcher：按 `(name, owner_id)` 查找 Agent，含权限校验 | P0 |
| AI-03 | queue：异步处理 AI 请求，不阻塞主线程 | P0 |
| AI-04 | 直连模式：服务端用用户的加密 API Key 直接调用 LLM | P1 |
| AI-05 | Webhook 模式：POST 到用户配置的外部 URL，Body 必须携带完整上下文（见下方 Payload 规范），避免外部服务二次回查 | P1 |
| AI-06 | 直连模式超时 60s（LLM 生成耗时长）；Webhook 模式超时 10s（只检查送达）；最多重试 2 次；失败后由 System Bot 在帖内回复错误 | P1 |
| AI-07 | Agent 回写接口：`POST /api/ai/reply`，Bearer Token 验证 | P0 |
| AI-08 | 私有 AI 权限：非 owner 的 @mention 被静默丢弃 | P0 |
| AI-09 | Agent 删除为软删除（`is_deleted=1`），禁止硬删除；dispatcher 匹配时加 `AND is_deleted = 0` | P0 |
| AI-10 | `/api/ai/reply` 必须反查 `job_queue` 确认任务存在且 `status IN ('processing','waiting_reply')`，防止持 Token 用户全站刷屏 | P0 |
| AI-11 | **编辑帖子/评论（PATCH）严禁触发 detector 和 AI 入队**；AI 只对首次发布的内容负责 | P0 |
| AI-12 | Webhook 签名使用 `agents.webhook_secret`（独立字段），不使用 token 哈希——token 只存哈希，无法用于 HMAC 签名 | P0 |
| AI-13 | 公共 AI（`owner_id IS NULL`）专属节流：同一用户对同一公共 AI 每分钟最多触发 N 次（默认 N=5），在 dispatcher 写入 job_queue 前用 SQL 查近 60s 记录拦截 | P1 |

#### AI 请求的完整数据流

```
用户发帖/评论（含 @mention）
         │
    [同步] HTTP 201 返回帖子/评论
         │
    detector.js ── 解析所有 @name
         │
    dispatcher.js（传入 postId + commentId? + userId）
         ├── 查询 DB: name=? AND (owner_id IS NULL OR owner_id=currentUser)
         ├── 未找到 → 静默丢弃
         └── 找到 → 写入 job_queue（记录 post_id + comment_id）
                  │
             [异步] queue.js worker
                  ├── model_type=openai/anthropic
                  │     └── 直连 LLM，超时 60s
                  ├── model_type=custom_webhook
                  │     └── POST to webhook_url，超时 10s（只检查送达）
                  │         └── AI 异步调用 POST /api/ai/reply 回写
                  └── 超时/失败 → System Bot 回复错误消息
                           │
                    agent_api.js 按 target_type 写入 posts 或 comments 表
                           │
                    socket.js 广播 WebSocket 事件
                           │
                    前端/TUI 实时展示 AI 回复
```

#### Webhook Payload 规范

外部 AI Agent 收到的 POST Body（携带完整上下文，无需二次回查 BBS）：

```json
{
  "event":        "ai_mention",
  "agent_name":   "Claude",
  "post_id":      123,
  "comment_id":   45,
  "trigger_text": "你好 @Claude，帮我总结一下这个问题：...",
  "author":       { "id": 7, "username": "alice" },
  "board":        { "id": 2, "name": "技术讨论" },
  "reply_to":     { "type": "comment", "id": 45 },
  "callback_url": "https://your-bbs.example.com/api/ai/reply"
}
```

签名头：`X-LBBS-Signature: <HMAC-SHA256(rawBody, agent.webhook_secret)>`

**为什么不用 token？** `token` 在数据库中只存 SHA-256 哈希，无法还原为明文用于 HMAC 签名。`webhook_secret` 是独立存储的专用签名密钥（可由系统生成并 AES 加密存储，创建 Agent 时一次性展示给用户）。

### 3.4 实时通信

| 需求ID | 描述 | 优先级 |
|--------|------|--------|
| WS-01 | Socket.io 连接，JWT 握手验证 | P0 |
| WS-02 | 事件：`new_post`、`new_comment`、`ai_reply`、`ai_error` | P0 |
| WS-03 | 房间隔离：用户只收到所在板块的消息 | P1 |

---

## 4. 数据模型

### 4.1 完整 Schema

```sql
-- 用户表（只存真实人类用户，AI 不在此建影子账户）
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user',  -- 'user' | 'admin'
  avatar_url    TEXT,
  bio           TEXT,
  token_version INTEGER NOT NULL DEFAULT 1,       -- 每次登出/改密 +1，实现 Refresh Token 全局吊销
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 板块表
CREATE TABLE boards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  description TEXT,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 帖子表
CREATE TABLE posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id    INTEGER NOT NULL REFERENCES boards(id),
  author_id   INTEGER NOT NULL REFERENCES users(id), -- AI 发帖时填其主人的 user_id（owner_id）
  agent_id    INTEGER REFERENCES agents(id),          -- 非 NULL 时表示本条由 AI 生成，前端据此显示 AI 名称
  title       TEXT    NOT NULL,
  content     TEXT    NOT NULL,
  is_deleted  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 评论表（支持2层嵌套）
CREATE TABLE comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL REFERENCES posts(id),
  author_id   INTEGER NOT NULL REFERENCES users(id), -- AI 回复时填其主人的 user_id（owner_id）
  agent_id    INTEGER REFERENCES agents(id),          -- 非 NULL 时表示本条由 AI 生成
  parent_id   INTEGER REFERENCES comments(id),        -- NULL = 顶层评论
  content     TEXT    NOT NULL,
  is_deleted  INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

-- AI Agent 表
CREATE TABLE agents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  owner_id        INTEGER REFERENCES users(id),  -- NULL = 全局公共AI
  token           TEXT    NOT NULL UNIQUE,        -- 回写用 Bearer Token (存哈希)
  api_key_enc     TEXT,                           -- AES-256-GCM 加密的 API Key
  webhook_url     TEXT,
  webhook_secret  TEXT,                           -- Webhook 签名密钥（明文或 AES 加密存储）
                                                  -- 独立于 token：token 只存哈希无法用于签名
  model_type      TEXT    NOT NULL DEFAULT 'custom_webhook',
  model_name      TEXT,
  system_prompt   TEXT,
  trigger_pattern TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  is_deleted      INTEGER NOT NULL DEFAULT 0,  -- 软删除：保留历史帖子的 AI 身份，永不硬删
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(name, owner_id)
);

-- ⚠️ 关键：公共AI名称全局唯一（UNIQUE约束对NULL无效，必须加此索引）
CREATE UNIQUE INDEX idx_public_agent_name
  ON agents(name) WHERE owner_id IS NULL;

-- 🔒 系统保留账户（id=1 硬编码，供 System Bot 发送错误通知用）
-- 必须在 db/init.js 建表后立即插入，不依赖业务逻辑
INSERT OR IGNORE INTO users (id, username, email, password_hash, role)
VALUES (1, 'system', 'system@localhost', 'NO_LOGIN_ALLOWED', 'admin');

-- AI 任务队列（持久化，服务重启不丢任务）
CREATE TABLE job_queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id     INTEGER NOT NULL REFERENCES agents(id),
  post_id      INTEGER NOT NULL REFERENCES posts(id),
  comment_id   INTEGER REFERENCES comments(id),  -- NULL=帖子触发；非NULL=评论触发，AI回复将挂在此评论下
  triggered_by INTEGER NOT NULL REFERENCES users(id),
  trigger_text TEXT,             -- detector 截取的触发上下文，供 Webhook payload 使用
  status       TEXT    NOT NULL DEFAULT 'pending',
               -- 状态机：pending → processing → waiting_reply（仅Webhook模式）→ done / failed
               -- 直连模式：processing 完成后直接 → done
               -- Webhook模式：HTTP 200受理后 → waiting_reply；AI回写后 → done
               -- /api/ai/reply 回写校验时查 status IN ('processing','waiting_reply')
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Agent 调用日志
CREATE TABLE agent_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id   INTEGER NOT NULL REFERENCES agents(id),
  job_id     INTEGER NOT NULL REFERENCES job_queue(id),
  status     TEXT    NOT NULL,
  latency_ms INTEGER,
  error_msg  TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

---

## 5. API 规范

### 5.1 基础约定

```
Base URL:   http://localhost:PORT/api
Auth:       Authorization: Bearer <jwt_access_token>
Content:    application/json
错误格式:   { "error": "ERROR_CODE", "message": "人类可读描述" }
```

### 5.2 认证接口

```
POST   /api/auth/register     注册
POST   /api/auth/login        登录，返回 { accessToken, refreshToken }
POST   /api/auth/refresh      刷新 Token
POST   /api/auth/logout       使 Refresh Token 失效
```

### 5.3 用户接口

```
GET    /api/users/me          获取当前用户信息
PATCH  /api/users/me          更新资料
GET    /api/users/:id         查看公开资料
```

### 5.4 留言板接口

```
GET    /api/boards                    获取所有板块
POST   /api/boards                    创建板块 [admin]
GET    /api/boards/:id/posts          获取帖子列表（分页）
POST   /api/boards/:id/posts          发帖
GET    /api/posts/:id                 获取帖子详情+评论
PATCH  /api/posts/:id                 编辑帖子 [owner]
DELETE /api/posts/:id                 软删除 [owner/admin]
POST   /api/posts/:id/comments        回帖
PATCH  /api/comments/:id              编辑评论 [owner]
DELETE /api/comments/:id              软删除 [owner/admin]
```

### 5.5 AI Agent 接口

```
# 用户管理自己的 Agent
GET    /api/agents/mine               我的 Agent 列表
POST   /api/agents                    创建私有 Agent
  name 字段约束：仅允许 ^[a-zA-Z0-9_\u4e00-\u9fff]+$（必须与 detector.js 正则一致）
PATCH  /api/agents/:id                修改配置
DELETE /api/agents/:id                软删除（将 is_deleted 设为 1，禁止硬删除）
                                      ⚠️ 硬删除会导致 posts.agent_id 外键冲突，或历史帖子
                                         的 agent_id 变 NULL，使 AI 发言变成主人本人发言
POST   /api/agents/:id/rotate-token   重新生成回写 Token
GET    /api/agents/:id/logs           调用日志

# AI 回写专用端点（支持回复帖子或评论）
POST   /api/ai/reply
  Header: Authorization: Bearer <agent_token>
  Body:   {
    "post_id":     123,
    "target_type": "post",        // "post" | "comment"
    "target_id":   123,
    "content":     "AI 的回复"
  }
  ⚠️ 安全校验：必须反查 job_queue，确认存在
     agent_id=当前AI AND post_id=请求post_id AND status='processing'
     的任务，否则拒绝（防止持 Token 的用户在全站任意刷屏）

# 管理员管理公共 Agent
GET    /api/admin/agents              [admin]
POST   /api/admin/agents              [admin]
PATCH  /api/admin/agents/:id          [admin]
```

### 5.6 WebSocket 事件

```javascript
// 连接时携带 JWT
const socket = io('ws://localhost:PORT', {
  auth: { token: jwtAccessToken }
});

socket.emit('join_board', { board_id: 1 });   // 订阅板块

socket.on('new_post',    (post) => { });
socket.on('new_comment', (comment) => { });
socket.on('ai_reply',    ({ post_id, target_type, target_id, agent_name, content }) => { });
socket.on('ai_error',    ({ post_id, agent_name, message }) => { });
```

---

## 6. CLI 规范

```bash
npx lbbs-next init                          # 初始化：生成 .env、建表
npx lbbs-next start [--port 3000] [--data ./data]
npx lbbs-next create-admin                  # 交互式创建管理员
npx lbbs-next add-ai --name Claude --type anthropic --key sk-ant-xxx
npx lbbs-next status                        # 查看运行状态
npx lbbs-next backup --output ./backup.db   # 备份数据库
```

---

## 7. 安全要求

| 类别 | 要求 |
|------|------|
| **密码** | bcrypt，cost factor ≥ 12 |
| **API Key 存储** | AES-256-GCM 加密，密钥来自 `.env` 的 `ENCRYPTION_KEY` |
| **JWT** | Access Token 15分钟，Refresh Token 7天；payload 中含 `token_version`，登出/改密时 `users.token_version+1` 实现全局吊销，无需独立存储长 Token |
| **Agent Token** | `crypto.randomBytes(32)` 生成，存 SHA-256 哈希，明文只返回一次 |
| **速率限制** | 全局 100req/min/IP，登录 5req/min/IP |
| **输入校验** | Fastify Schema + zod，全部入参强制校验 |
| **Webhook 签名** | 推送时附带 `X-LBBS-Signature` 头；HMAC 密钥使用**该 Agent 的 rawToken**（用户持有），而非全局 `WEBHOOK_SECRET`——多用户场景下不能把全局密钥发给每个用户 |

---

## 8. 非功能性要求

| 指标 | 目标 |
|------|------|
| 并发用户 | ≤ 50 同时在线 |
| API 响应时间 | P99 < 200ms（不含 AI 调用） |
| AI 任务超时 | 直连 LLM 60s；Webhook 送达检查 10s |
| 启动时间 | 冷启动 < 3 秒 |
| Docker 镜像 | 压缩后 < 150MB |

---

## 9. 不在 v0.1.0 范围内

- 邮件通知 / 文件上传 / 全文搜索
- TUI 客户端（规划为 v0.2.0）
- 移动端 App / 联邦协议

---

## 10. 里程碑

| 阶段 | 内容 |
|------|------|
| M1 | DB Schema + Auth + 基础 CRUD → 多用户登录发帖跑通 |
| M2 | AI 系统（公共 AI + 队列 + 回写）→ @mention 触发 AI 跑通 |
| M3 | 私有 AI（用户绑定 + 权限校验）→ 私有 AI 功能完整 |
| M4 | Web 前端（htmx + PicoCSS）→ 完整浏览器界面 |
| M5 | Docker + npm 打包 + CLI → `npx lbbs-next start` 一行跑通 |
| M6 | 安全加固 + 日志 + 测试覆盖 → 可交付给他人使用 |
