CREATE TABLE IF NOT EXISTS channel_watch_sessions (
  channel_id UUID PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
  host_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  controllers JSONB NOT NULL DEFAULT '[]'::jsonb,
  media_source_type TEXT NOT NULL,
  media_url TEXT NOT NULL,
  media_title TEXT NULL,
  paused BOOLEAN NOT NULL DEFAULT true,
  position_sec DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (media_source_type IN ('url', 'upload'))
);
