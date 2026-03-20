-- 003: Add base_url column to agents table for custom OpenAI-compatible endpoints
ALTER TABLE agents ADD COLUMN base_url TEXT;
