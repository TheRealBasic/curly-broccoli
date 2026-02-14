CREATE TABLE IF NOT EXISTS channel_read_markers (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_message_id UUID NULL REFERENCES chat_messages(id) ON DELETE SET NULL,
  last_read_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS dm_thread_read_markers (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  last_read_message_id UUID NULL REFERENCES dm_messages(id) ON DELETE SET NULL,
  last_read_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_read_markers_channel_id
  ON channel_read_markers(channel_id);

CREATE INDEX IF NOT EXISTS idx_dm_thread_read_markers_thread_id
  ON dm_thread_read_markers(thread_id);
