import { mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import config from '../config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let db = null

export function getDb() {
  if (db) return db

  mkdirSync(config.dataDir, { recursive: true })
  const dbPath = join(config.dataDir, 'bbs.db')
  db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  return db
}

export function initializeDatabase() {
  const database = getDb()
  const sql = readFileSync(join(__dirname, 'migrations', '001_init.sql'), 'utf8')
  database.exec(sql)

  // Run incremental migrations for existing databases
  const migrations = ['002_agents_updated_at.sql']
  for (const file of migrations) {
    try {
      const migrationSql = readFileSync(join(__dirname, 'migrations', file), 'utf8')
      database.exec(migrationSql)
    } catch {
      // Column already exists — safe to ignore
    }
  }

  return database
}

export function closeDb() {
  if (db) {
    db.close()
    db = null
  }
}
