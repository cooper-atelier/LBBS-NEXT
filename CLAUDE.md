# CLAUDE.md — lbbs-next 项目 AI 协作指南

> 这份文件是写给 AI 编程助手的**宏观框架说明**。
> 实施细节和逐阶段任务请查阅 **PROGRESS.md** 和 **.agent/plans**中相关数字阶段的md file。
> 完整需求和数据模型请查阅 **PRD.md**。

---

## 项目一句话

lbbs-next 是一个**可 npm 分发的自托管留言板**，内置多用户系统与私有/公共 AI Agent 对话机制，SQLite 单文件存储，Docker 一键部署。

---

## 项目结构

```
lbbs-next/
├── bin/cli.js              # CLI 入口：npx lbbs-next <command>
├── src/
│   ├── server.js           # Fastify 初始化、插件注册、优雅关闭
│   ├── config.js           # 读取 .env，统一暴露配置（禁止直接用 process.env）
│   ├── db/
│   │   ├── init.js         # 建表 + 种子数据（幂等）
│   │   ├── migrations/     # 版本化变更：001_init.sql, 002_xxx.sql
│   │   └── queries.js      # 封装所有 SQL，禁止在路由层写原始查询
│   ├── middleware/
│   │   ├── auth.js         # verifyJWT → request.user
│   │   ├── rateLimit.js    # @fastify/rate-limit 配置
│   │   └── validate.js     # 共用校验工具
│   ├── api/
│   │   ├── auth.js         # /api/auth/*
│   │   ├── board.js        # /api/boards/*, /api/posts/*, /api/comments/*
│   │   ├── users.js        # /api/users/*
│   │   ├── agents.js       # /api/agents/*（用户管理私有AI）
│   │   └── admin.js        # /api/admin/*（需要 admin 角色）
│   ├── ai/
│   │   ├── detector.js     # extractMentions(text) → string[]（纯函数）
│   │   ├── dispatcher.js   # 权限校验 + 写入 job_queue（不发网络请求）
│   │   ├── queue.js        # Worker：原子抓取 + 处理 job_queue
│   │   ├── providers/
│   │   │   ├── openai.js
│   │   │   ├── anthropic.js
│   │   │   └── webhook.js
│   │   └── agent_api.js    # POST /api/ai/reply（AI 回写入口）
│   └── ws/
│       └── socket.js       # Socket.io，事件广播
├── public/                 # htmx + PicoCSS，无构建步骤
├── data/                   # bbs.db 存放处（.gitignore）
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## 不可推翻的架构决策

| # | 决策 | 原因 |
|---|------|------|
| 1 | `better-sqlite3`（同步 API） | 轻量、单文件；代码中不出现回调或 `.then()` 式 DB 操作 |
| 2 | Fastify（不用 Express） | 原生 JSON Schema 校验；每个路由必须附带 schema |
| 3 | 发帖立即返回 201，AI 完全异步 | AI 响应可长达 60s，不能阻塞主线程 |
| 4 | 私有 AI 权限在 SQL 层校验 | dispatcher 的 WHERE 子句完成鉴权，不在 JS 层做 if 判断 |
| 5 | Agent token 只存 SHA-256 哈希 | 明文一次性返回给用户，DB 存哈希 |
| 6 | API Key 用 AES-256-GCM 加密存储 | 密钥来自 `.env` 的 `ENCRYPTION_KEY` |
| 7 | `webhook_secret` 独立于 `token` | token 存哈希无法用于 HMAC 签名，必须单独存签名密钥 |
| 8 | Agent 只软删除，永不硬删 | 硬删导致历史帖子 `agent_id` 变 NULL，AI 发言变成主人发言 |
| 9 | PATCH 编辑操作不触发 AI | 避免反复编辑导致 AI 刷屏时间循环 |
| 10 | Webhook 任务状态：`waiting_reply` 中间态 | HTTP 200 受理后不能立即标 done，否则回写校验失败 |

---

## 编码规范（一口气读完）

- **ES Modules**，不用 CommonJS
- **Node.js 20+**，async/await，禁止新写回调
- 缩进 2 空格，不加分号，单引号
- 命名：变量/函数 camelCase，文件 kebab-case，DB 字段 snake_case，常量 UPPER_SNAKE
- SQL 关键字大写，全部参数化，禁止字符串拼接
- 时间戳存 Unix 整数秒，API 返回时序列化为 ISO 8601
- 错误响应统一格式：`{ error: 'ERROR_CODE', message: '中文描述' }`

---

## 核心业务规则速查（16 条禁忌）

1. 路由处理器里 **await AI 响应** → 超时
2. 直连 LLM 超时设 **5s** → 重试触发 3 条重复回复
3. **明文**存储 API Key 或 Agent Token
4. 只用 `UNIQUE(name, owner_id)` 保证公共AI唯一 → SQLite NULL≠NULL，需加 partial index
5. dispatcher 里做 **JS 层**权限判断 → 让 SQL 来做
6. 在 `db/` 以外写**原始 SQL**
7. 直接用 `process.env.XXX` → 通过 `config.js` 统一读取
8. 前端引入 **React/Vue/构建链**
9. Agent name 含**空格或连字符** → detector 正则截取不到，AI 永不触发
10. 列表查询和详情查询用**同一套软删除逻辑** → 见 AGENTPLAN Phase 2
11. 在 `users` 表给 AI 建**影子账户** → `agents` 独立 id，AI 发帖用 `owner_id`
12. 用先 SELECT 再 UPDATE **两步**抓取 job_queue → 轮询重叠重复处理；用 `UPDATE...RETURNING`
13. 用 **token 哈希**做 Webhook HMAC 签名 → token 不可逆，需独立的 `webhook_secret`
14. **硬删除** Agent 记录 → 外键报错或历史帖子身份篡改
15. `/api/ai/reply` **不校验 job_queue** 直接写入 → 全站刷屏漏洞
16. `postSystemMessage` 只传 `postId` 不传 `parentId` → 报错挂错楼层

---

## 关键数据约定

**软删除（两种场景）**
- 列表查询：`WHERE is_deleted = 0`（不展示）
- 详情/评论树：不过滤，API 层替换内容为 `[此内容已删除]`

**AI 身份**
- `posts/comments.author_id` = AI 主人的 `owner_id`
- `posts/comments.agent_id` = `agents.id`（非 NULL 表示 AI 发言）
- 前端看到 `agent_id != null` → 去 `agents` 表取名称/头像

**job_queue 状态机**
```
pending → processing → waiting_reply（仅 Webhook）→ done
                     ↘ failed（超过重试上限）
```

**系统账户**：`users.id = 1`（硬编码，init.js 种子插入），所有 System Bot 消息的 `author_id = 1`

---

## 环境变量

```bash
PORT=3000
HOST=0.0.0.0
DATA_DIR=./data
JWT_SECRET=           # 32+ 字符随机串
JWT_REFRESH_SECRET=   # 另一个，与上面不同
ENCRYPTION_KEY=       # 64位hex（32字节 AES-256 密钥）
ALLOWED_ORIGINS=http://localhost:3000
LOG_LEVEL=info
```

生成命令：`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

---

## 开发启动

```bash
cp .env.example .env && npm install
npm run dev:init   # 建表 + 插入种子数据
npm run dev        # nodemon 热重载
docker compose up -d  # 或 Docker 启动
```

---

**核心哲学**：简单可靠优先于功能丰富。不确定加不加？先不加。不确定哪种实现？选更简单的。
