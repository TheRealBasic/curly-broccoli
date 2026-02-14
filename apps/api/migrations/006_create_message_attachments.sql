CREATE TABLE IF NOT EXISTS message_attachments (
  id UUID PRIMARY KEY,
  uploaded_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_attachments_uploaded_by
  ON message_attachments(uploaded_by_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_message_attachments (
  message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  attachment_id UUID NOT NULL REFERENCES message_attachments(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_message_attachments_attachment_id
  ON chat_message_attachments(attachment_id);
