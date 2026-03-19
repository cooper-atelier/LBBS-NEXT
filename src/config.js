import 'dotenv/config'

const required = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'ENCRYPTION_KEY']
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`)
  }
}

if (!/^[0-9a-f]{64}$/i.test(process.env.ENCRYPTION_KEY)) {
  throw new Error('ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)')
}

const port = parseInt(process.env.PORT || '3000', 10)

const config = Object.freeze({
  port,
  host: process.env.HOST || '0.0.0.0',
  dataDir: process.env.DATA_DIR || './data',
  jwtSecret: process.env.JWT_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  encryptionKey: process.env.ENCRYPTION_KEY,
  allowedOrigins: (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(','),
  logLevel: process.env.LOG_LEVEL || 'info',
  baseUrl: process.env.BASE_URL || `http://localhost:${port}`,
  publicAiRateLimit: parseInt(process.env.PUBLIC_AI_RATE_LIMIT || '5', 10),

  BCRYPT_ROUNDS: 12,
  JWT_ACCESS_EXPIRES: '15m',
  JWT_REFRESH_EXPIRES: '7d',
  SYSTEM_USER_ID: 1,
  RATE_LIMIT_GLOBAL: 100,
  RATE_LIMIT_LOGIN: 5,
  LLM_TIMEOUT_MS: 60_000,
  WEBHOOK_TIMEOUT_MS: 10_000,
  QUEUE_POLL_INTERVAL_MS: 2000,
  QUEUE_CLAIM_LIMIT: 5,
  MAX_JOB_ATTEMPTS: 2,
})

export default config
