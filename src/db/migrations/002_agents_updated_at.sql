-- 002_agents_updated_at.sql — Add updated_at column to agents table
ALTER TABLE agents ADD COLUMN updated_at INTEGER NOT NULL DEFAULT (unixepoch());
