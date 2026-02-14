CREATE INDEX IF NOT EXISTS idx_chat_messages_search_vector
  ON chat_messages
  USING GIN (to_tsvector('simple', coalesce(text, '')));

CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_created_at
  ON chat_messages (channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dm_messages_search_vector
  ON dm_messages
  USING GIN (to_tsvector('simple', coalesce(text, '')));

CREATE INDEX IF NOT EXISTS idx_dm_messages_thread_created_at
  ON dm_messages (thread_id, created_at DESC);
