ALTER TABLE server_ai_settings
  ADD COLUMN IF NOT EXISTS ai_invocation_policy TEXT NOT NULL DEFAULT 'everyone';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'server_ai_settings_ai_invocation_policy_check'
  ) THEN
    ALTER TABLE server_ai_settings
      ADD CONSTRAINT server_ai_settings_ai_invocation_policy_check
      CHECK (ai_invocation_policy IN ('everyone', 'roles'));
  END IF;
END
$$;
