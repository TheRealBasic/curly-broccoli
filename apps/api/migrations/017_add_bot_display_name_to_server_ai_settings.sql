ALTER TABLE server_ai_settings
  ADD COLUMN IF NOT EXISTS bot_display_name TEXT NOT NULL DEFAULT 'assistant';
