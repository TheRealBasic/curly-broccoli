CREATE TABLE IF NOT EXISTS server_ai_settings (
  server_id UUID PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  bot_display_name TEXT NOT NULL DEFAULT 'assistant',
  model TEXT NOT NULL DEFAULT 'gpt-4.1-mini',
  system_prompt TEXT NULL,
  max_tokens_per_reply INTEGER,
  temperature NUMERIC,
  allow_dm_invocation BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
