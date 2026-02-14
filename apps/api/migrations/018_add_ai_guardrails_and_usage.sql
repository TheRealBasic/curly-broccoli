ALTER TABLE server_ai_settings
  ADD COLUMN IF NOT EXISTS max_prompt_chars INTEGER,
  ADD COLUMN IF NOT EXISTS max_completion_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS rate_limit_user_requests INTEGER,
  ADD COLUMN IF NOT EXISTS rate_limit_server_requests INTEGER,
  ADD COLUMN IF NOT EXISTS rate_limit_window_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS burst_limit_requests INTEGER,
  ADD COLUMN IF NOT EXISTS burst_window_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS daily_token_budget INTEGER,
  ADD COLUMN IF NOT EXISTS monthly_token_budget INTEGER,
  ADD COLUMN IF NOT EXISTS auto_disable_on_budget_exceeded BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS disabled_reason TEXT;

CREATE TABLE IF NOT EXISTS server_ai_usage_daily (
  server_id UUID NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  usage_date DATE NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  latency_total_ms BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, usage_date)
);

CREATE INDEX IF NOT EXISTS idx_server_ai_usage_daily_server_date
  ON server_ai_usage_daily(server_id, usage_date DESC);
