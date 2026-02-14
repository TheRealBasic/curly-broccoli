CREATE TABLE IF NOT EXISTS dm_threads (
  id UUID PRIMARY KEY,
  user_a_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (user_a_id <> user_b_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_threads_unique_pair
  ON dm_threads (LEAST(user_a_id, user_b_id), GREATEST(user_a_id, user_b_id));

CREATE INDEX IF NOT EXISTS idx_dm_threads_user_a_id
  ON dm_threads(user_a_id);

CREATE INDEX IF NOT EXISTS idx_dm_threads_user_b_id
  ON dm_threads(user_b_id);

CREATE TABLE IF NOT EXISTS dm_messages (
  id UUID PRIMARY KEY,
  thread_id UUID NOT NULL REFERENCES dm_threads(id) ON DELETE CASCADE,
  sender_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dm_messages_thread_created_at
  ON dm_messages(thread_id, created_at DESC);
