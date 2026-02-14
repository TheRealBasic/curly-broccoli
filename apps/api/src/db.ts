import crypto from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type {
  ChannelSummary,
  ChatMessage,
  DmMessage,
  DmThreadSummary,
  MessageAttachment,
  ServerMember,
  ServerSummary,
  type CoWatchPlaybackState,
} from '@curly-broccoli/shared';

const DEFAULT_HISTORY_LIMIT = 50;

export const chatHistoryLimit = Number(process.env.CHAT_HISTORY_LIMIT ?? DEFAULT_HISTORY_LIMIT);

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to start the API.');
}

const pool = new Pool({
  connectionString: databaseUrl,
});

type ChatMessageRow = {
  id: string;
  channel_id: string;
  user_id: string | null;
  user_name: string;
  text: string;
  created_at: Date | string;
  edited_at: Date | string | null;
};

type MessageAttachmentRow = {
  id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
};

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
};

type RefreshTokenRow = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
};

type ServerRow = {
  id: string;
  name: string;
  owner_id: string;
  soundboard_enabled: boolean;
  voice_effects_enabled: boolean;
};

type ServerAiSettingsRow = {
  server_id: string;
  enabled: boolean;
  bot_display_name: string;
  model: string;
  system_prompt: string | null;
  max_tokens_per_reply: number | null;
  temperature: string | number | null;
  allow_dm_invocation: boolean;
};

type ChannelRow = {
  id: string;
  server_id: string;
  name: string;
};

type ServerMembershipRow = {
  user_id: string;
  username: string;
  role: 'owner' | 'member';
  can_share_screen: boolean;
  is_muted: boolean;
};

type DmThreadRow = {
  id: string;
  user_a_id: string;
  user_b_id: string;
  other_user_id: string;
  other_username: string;
  last_message_at: Date | string | null;
};



type WatchSessionRow = {
  channel_id: string;
  host_user_id: string;
  controllers: string[];
  media_source_type: 'url' | 'upload';
  media_url: string;
  media_title: string | null;
  paused: boolean;
  position_sec: number;
  last_event_at: Date | string;
};
type DmMessageRow = {
  id: string;
  thread_id: string;
  sender_user_id: string;
  sender_username: string;
  text: string;
  created_at: Date | string;
};

type SearchMessageRow = {
  id: string;
  channel_id: string;
  user_id: string | null;
  user_name: string;
  text: string;
  created_at: Date | string;
  edited_at: Date | string | null;
};

type SearchDmMessageRow = {
  id: string;
  thread_id: string;
  sender_user_id: string;
  sender_username: string;
  text: string;
  created_at: Date | string;
};

type PaginationCursor = {
  createdAt: string;
  id: string;
};

type MessagePage<T> = {
  messages: T[];
  nextCursor: string | null;
  prevCursor: string | null;
};

export type UnreadSummary = {
  channels: Record<string, number>;
  dmThreads: Record<string, number>;
  totalChannels: number;
  totalDmThreads: number;
};

export type ServerAiSettings = {
  serverId: string;
  enabled: boolean;
  botDisplayName: string;
  model: string;
  systemPrompt: string | null;
  maxTokensPerReply: number | null;
  temperature: number | null;
  allowDmInvocation: boolean;
};

type UpdateServerAiSettingsPatch = {
  enabled?: boolean;
  botDisplayName?: string;
  model?: string;
  systemPrompt?: string | null;
  maxTokensPerReply?: number | null;
  temperature?: number | null;
  allowDmInvocation?: boolean;
};

type CursorPaginationOptions = {
  limit?: number;
  before?: string;
  after?: string;
  offset?: number;
};

function encodeCursorToken(cursor: PaginationCursor) {
  return Buffer.from(`${cursor.createdAt}|${cursor.id}`, 'utf8').toString('base64url');
}

function decodeCursorToken(token: string): PaginationCursor | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const separatorIndex = decoded.indexOf('|');
    if (separatorIndex <= 0 || separatorIndex === decoded.length - 1) {
      return null;
    }

    const createdAt = decoded.slice(0, separatorIndex);
    const id = decoded.slice(separatorIndex + 1);
    const timestamp = Date.parse(createdAt);
    if (!Number.isFinite(timestamp) || !id) {
      return null;
    }

    return {
      createdAt: new Date(timestamp).toISOString(),
      id,
    };
  } catch {
    return null;
  }
}

function parseCursorOrThrow(raw: string | undefined, label: 'before' | 'after') {
  if (!raw) {
    return null;
  }

  const cursor = decodeCursorToken(raw);
  if (!cursor) {
    throw new Error(`Invalid ${label} cursor.`);
  }

  return cursor;
}

function toCursor(createdAt: Date | string, id: string): PaginationCursor {
  return { createdAt: new Date(createdAt).toISOString(), id };
}


function deriveAttachmentCategory(mimeType: string): AttachmentCategory {
  if (mimeType.startsWith('image/')) {
    return 'image';
  }

  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }

  if (mimeType.startsWith('video/')) {
    return 'video';
  }

  if (mimeType.startsWith('text/') || mimeType.startsWith('application/')) {
    return 'document';
  }

  return 'other';
}

function mapAttachmentRow(row: MessageAttachmentRow): MessageAttachment {
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    category: deriveAttachmentCategory(row.mime_type),
    sizeBytes: row.size_bytes,
    url: `/${row.storage_path}`,
  };
}

function mapRow(row: ChatMessageRow, attachments: MessageAttachment[] = []): ChatMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    userId: row.user_id,
    user: row.user_name,
    text: row.text,
    attachments,
    createdAt: new Date(row.created_at).toISOString(),
    editedAt: row.edited_at ? new Date(row.edited_at).toISOString() : null,
  };
}

async function fetchAttachmentsForMessages(messageIds: string[]) {
  if (messageIds.length === 0) {
    return new Map<string, MessageAttachment[]>();
  }

  const rows = await pool.query<
    MessageAttachmentRow & {
      message_id: string;
    }
  >(
    `
      SELECT
        links.message_id,
        attachments.id,
        attachments.file_name,
        attachments.mime_type,
        attachments.size_bytes,
        attachments.storage_path
      FROM chat_message_attachments links
      INNER JOIN message_attachments attachments ON attachments.id = links.attachment_id
      WHERE links.message_id = ANY($1::uuid[])
      ORDER BY links.created_at ASC;
    `,
    [messageIds],
  );

  const byMessageId = new Map<string, MessageAttachment[]>();
  for (const row of rows.rows) {
    const list = byMessageId.get(row.message_id) ?? [];
    list.push(mapAttachmentRow(row));
    byMessageId.set(row.message_id, list);
  }

  return byMessageId;
}

function mapDmThreadRow(row: DmThreadRow): DmThreadSummary {
  return {
    id: row.id,
    otherUserId: row.other_user_id,
    otherUsername: row.other_username,
    lastMessageAt: row.last_message_at ? new Date(row.last_message_at).toISOString() : null,
  };
}

function mapDmMessageRow(row: DmMessageRow): DmMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    senderUserId: row.sender_user_id,
    senderUsername: row.sender_username,
    text: row.text,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export async function runMigrations() {
  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `,
  );

  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const migrationsDir = path.resolve(currentDir, '../migrations');
  const migrationFiles = (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const filename of migrationFiles) {
    const alreadyApplied = await pool.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations WHERE filename = $1',
      [filename],
    );

    if (alreadyApplied.rowCount) {
      continue;
    }

    const sql = await readFile(path.join(migrationsDir, filename), 'utf8');
    await pool.query('BEGIN');

    try {
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations(filename) VALUES ($1)', [filename]);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
  }
}

export async function createUser(id: string, username: string, passwordHash: string) {
  const inserted = await pool.query<UserRow>(
    `
      INSERT INTO users (id, username, password_hash)
      VALUES ($1, $2, $3)
      RETURNING id, username, password_hash;
    `,
    [id, username, passwordHash],
  );

  return inserted.rows[0];
}

export async function findUserByUsername(username: string) {
  const result = await pool.query<UserRow>(
    `
      SELECT id, username, password_hash
      FROM users
      WHERE username = $1;
    `,
    [username],
  );

  return result.rows[0] ?? null;
}

export async function findUserById(userId: string) {
  const result = await pool.query<UserRow>(
    `
      SELECT id, username, password_hash
      FROM users
      WHERE id = $1;
    `,
    [userId],
  );

  return result.rows[0] ?? null;
}

export async function storeRefreshToken(
  id: string,
  userId: string,
  tokenHash: string,
  expiresAt: string,
) {
  await pool.query(
    `
      INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
      VALUES ($1, $2, $3, $4);
    `,
    [id, userId, tokenHash, expiresAt],
  );
}

export async function findRefreshToken(tokenHash: string) {
  const result = await pool.query<RefreshTokenRow>(
    `
      SELECT id, user_id, token_hash, expires_at, revoked_at
      FROM refresh_tokens
      WHERE token_hash = $1;
    `,
    [tokenHash],
  );

  return result.rows[0] ?? null;
}

export async function revokeRefreshToken(tokenHash: string) {
  await pool.query(
    `
      UPDATE refresh_tokens
      SET revoked_at = NOW()
      WHERE token_hash = $1 AND revoked_at IS NULL;
    `,
    [tokenHash],
  );
}

export async function createServer(id: string, name: string, ownerId: string) {
  const inserted = await pool.query<ServerRow>(
    `
      INSERT INTO servers (id, name, owner_id)
      VALUES ($1, $2, $3)
      RETURNING id, name, owner_id, soundboard_enabled, voice_effects_enabled;
    `,
    [id, name, ownerId],
  );

  const server = inserted.rows[0];
  return {
    id: server.id,
    name: server.name,
    ownerId: server.owner_id,
    soundboardEnabled: server.soundboard_enabled,
    voiceEffectsEnabled: server.voice_effects_enabled,
  } satisfies ServerSummary;
}

export async function addServerMembership(
  serverId: string,
  userId: string,
  role: 'owner' | 'member',
) {
  await pool.query(
    `
      INSERT INTO server_memberships (server_id, user_id, role)
      VALUES ($1, $2, $3)
      ON CONFLICT (server_id, user_id) DO UPDATE SET role = EXCLUDED.role;
    `,
    [serverId, userId, role],
  );
}

export async function listServersForUser(userId: string) {
  const result = await pool.query<ServerRow>(
    `
      SELECT s.id, s.name, s.owner_id, s.soundboard_enabled, s.voice_effects_enabled
      FROM servers s
      INNER JOIN server_memberships sm ON sm.server_id = s.id
      WHERE sm.user_id = $1
      ORDER BY s.created_at ASC;
    `,
    [userId],
  );

  return result.rows.map(
    (row) => ({
      id: row.id,
      name: row.name,
      ownerId: row.owner_id,
      soundboardEnabled: row.soundboard_enabled,
      voiceEffectsEnabled: row.voice_effects_enabled,
    }) satisfies ServerSummary,
  );
}

export async function listChannelsForServer(serverId: string, userId: string) {
  const result = await pool.query<ChannelRow>(
    `
      SELECT c.id, c.server_id, c.name
      FROM channels c
      WHERE c.server_id = $1
        AND EXISTS (
          SELECT 1 FROM server_memberships sm
          WHERE sm.server_id = c.server_id AND sm.user_id = $2
        )
      ORDER BY c.created_at ASC;
    `,
    [serverId, userId],
  );

  return result.rows.map(
    (row) => ({ id: row.id, serverId: row.server_id, name: row.name }) satisfies ChannelSummary,
  );
}

export async function getMembershipRole(serverId: string, userId: string) {
  const result = await pool.query<{ role: 'owner' | 'member' }>(
    `
      SELECT role
      FROM server_memberships
      WHERE server_id = $1 AND user_id = $2;
    `,
    [serverId, userId],
  );

  return result.rows[0]?.role ?? null;
}

export async function isMemberOfServer(serverId: string, userId: string) {
  const result = await pool.query<{ found: number }>(
    `
      SELECT 1 AS found
      FROM server_memberships
      WHERE server_id = $1 AND user_id = $2;
    `,
    [serverId, userId],
  );

  return Boolean(result.rowCount);
}

export async function createChannel(id: string, serverId: string, name: string, userId: string) {
  const member = await isMemberOfServer(serverId, userId);
  if (!member) {
    throw new Error('Not a member of server');
  }

  const inserted = await pool.query<ChannelRow>(
    `
      INSERT INTO channels (id, server_id, name)
      VALUES ($1, $2, $3)
      RETURNING id, server_id, name;
    `,
    [id, serverId, name],
  );

  const channel = inserted.rows[0];
  return {
    id: channel.id,
    serverId: channel.server_id,
    name: channel.name,
  } satisfies ChannelSummary;
}

export async function listServerMembers(serverId: string, userId: string) {
  const membership = await isMemberOfServer(serverId, userId);
  if (!membership) {
    throw new Error('Not a member of server');
  }

  const result = await pool.query<ServerMembershipRow>(
    `
      SELECT sm.user_id, u.username, sm.role, sm.can_share_screen, (m.user_id IS NOT NULL) AS is_muted
      FROM server_memberships sm
      INNER JOIN users u ON u.id = sm.user_id
      LEFT JOIN server_mutes m ON m.server_id = sm.server_id AND m.user_id = sm.user_id
      WHERE sm.server_id = $1
      ORDER BY
        CASE WHEN sm.role = 'owner' THEN 0 ELSE 1 END ASC,
        u.username ASC;
    `,
    [serverId],
  );

  return result.rows.map(
    (row) =>
      ({
        userId: row.user_id,
        username: row.username,
        role: row.role,
        canShareScreen: row.can_share_screen,
        isMuted: row.is_muted,
      }) satisfies ServerMember,
  );
}

export async function getServerIdForChannel(channelId: string) {
  const result = await pool.query<{ server_id: string }>(
    `
      SELECT server_id
      FROM channels
      WHERE id = $1;
    `,
    [channelId],
  );

  return result.rows[0] ?? null;
}

export async function canAccessChannel(channelId: string, userId: string) {
  const result = await pool.query<{ found: number }>(
    `
      SELECT 1 AS found
      FROM channels c
      INNER JOIN server_memberships sm ON sm.server_id = c.server_id
      WHERE c.id = $1 AND sm.user_id = $2;
    `,
    [channelId, userId],
  );

  return Boolean(result.rowCount);
}

export async function canManageScreenShare(channelId: string, userId: string) {
  const result = await pool.query<{ role: 'owner' | 'member'; can_share_screen: boolean }>(
    `
      SELECT sm.role, sm.can_share_screen
      FROM channels c
      INNER JOIN server_memberships sm ON sm.server_id = c.server_id
      WHERE c.id = $1 AND sm.user_id = $2;
    `,
    [channelId, userId],
  );

  const membership = result.rows[0];
  if (!membership) {
    return { canShare: false, canModerate: false };
  }

  return {
    canShare: membership.role === 'owner' || membership.can_share_screen,
    canModerate: membership.role === 'owner',
  };
}


export async function getServerAudioSettingsByChannel(channelId: string) {
  const result = await pool.query<{ soundboard_enabled: boolean; voice_effects_enabled: boolean }>(
    `
      SELECT s.soundboard_enabled, s.voice_effects_enabled
      FROM channels c
      INNER JOIN servers s ON s.id = c.server_id
      WHERE c.id = $1;
    `,
    [channelId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    soundboardEnabled: row.soundboard_enabled,
    voiceEffectsEnabled: row.voice_effects_enabled,
  };
}

export async function updateServerAudioSettings(
  serverId: string,
  actorUserId: string,
  input: { soundboardEnabled: boolean; voiceEffectsEnabled: boolean },
) {
  const actorRole = await getMembershipRole(serverId, actorUserId);
  if (actorRole !== 'owner') {
    throw new MembershipError('ACTOR_NOT_OWNER', 'Only owners can update server audio settings');
  }

  const updated = await pool.query<ServerRow>(
    `
      UPDATE servers
      SET soundboard_enabled = $2,
          voice_effects_enabled = $3
      WHERE id = $1
      RETURNING id, name, owner_id, soundboard_enabled, voice_effects_enabled;
    `,
    [serverId, input.soundboardEnabled, input.voiceEffectsEnabled],
  );

  const server = updated.rows[0];
  if (!server) {
    throw new MembershipError('TARGET_NOT_MEMBER', 'Server not found');
  }

  return {
    id: server.id,
    name: server.name,
    ownerId: server.owner_id,
    soundboardEnabled: server.soundboard_enabled,
    voiceEffectsEnabled: server.voice_effects_enabled,
  } satisfies ServerSummary;
}

function mapServerAiSettingsRow(row: ServerAiSettingsRow): ServerAiSettings {
  return {
    serverId: row.server_id,
    enabled: row.enabled,
    botDisplayName: row.bot_display_name,
    model: row.model,
    systemPrompt: row.system_prompt,
    maxTokensPerReply: row.max_tokens_per_reply,
    temperature: row.temperature === null ? null : Number(row.temperature),
    allowDmInvocation: row.allow_dm_invocation,
  };
}

export async function getServerAiSettings(serverId: string) {
  const result = await pool.query<ServerAiSettingsRow>(
    `
      SELECT s.id AS server_id,
             COALESCE(sas.enabled, FALSE) AS enabled,
             COALESCE(NULLIF(TRIM(sas.bot_display_name), ''), 'assistant') AS bot_display_name,
             COALESCE(sas.model, 'gpt-4.1-mini') AS model,
             sas.system_prompt,
             sas.max_tokens_per_reply,
             sas.temperature,
             COALESCE(sas.allow_dm_invocation, FALSE) AS allow_dm_invocation
      FROM servers s
      LEFT JOIN server_ai_settings sas ON sas.server_id = s.id
      WHERE s.id = $1;
    `,
    [serverId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return mapServerAiSettingsRow(row);
}

export async function updateServerAiSettings(
  serverId: string,
  actorUserId: string,
  patch: UpdateServerAiSettingsPatch,
) {
  const actorRole = await getMembershipRole(serverId, actorUserId);
  if (actorRole !== 'owner') {
    throw new MembershipError('ACTOR_NOT_OWNER', 'Only owners can update server AI settings');
  }

  await pool.query(
    `
      INSERT INTO server_ai_settings (server_id)
      VALUES ($1)
      ON CONFLICT (server_id) DO NOTHING;
    `,
    [serverId],
  );

  const assignments: string[] = [];
  const values: Array<string | boolean | number | null> = [serverId];

  if (patch.enabled !== undefined) {
    assignments.push(`enabled = $${values.length + 1}`);
    values.push(patch.enabled);
  }

  if (patch.botDisplayName !== undefined) {
    assignments.push(`bot_display_name = $${values.length + 1}`);
    values.push(patch.botDisplayName);
  }

  if (patch.model !== undefined) {
    assignments.push(`model = $${values.length + 1}`);
    values.push(patch.model);
  }

  if (patch.systemPrompt !== undefined) {
    assignments.push(`system_prompt = $${values.length + 1}`);
    values.push(patch.systemPrompt);
  }

  if (patch.maxTokensPerReply !== undefined) {
    assignments.push(`max_tokens_per_reply = $${values.length + 1}`);
    values.push(patch.maxTokensPerReply);
  }

  if (patch.temperature !== undefined) {
    assignments.push(`temperature = $${values.length + 1}`);
    values.push(patch.temperature);
  }

  if (patch.allowDmInvocation !== undefined) {
    assignments.push(`allow_dm_invocation = $${values.length + 1}`);
    values.push(patch.allowDmInvocation);
  }

  if (assignments.length === 0) {
    const existing = await getServerAiSettings(serverId);
    if (!existing) {
      throw new MembershipError('TARGET_NOT_MEMBER', 'Server not found');
    }
    return existing;
  }

  const updated = await pool.query<ServerAiSettingsRow>(
    `
      UPDATE server_ai_settings
      SET ${assignments.join(', ')}
      WHERE server_id = $1
      RETURNING server_id, enabled, bot_display_name, model, system_prompt, max_tokens_per_reply, temperature, allow_dm_invocation;
    `,
    values,
  );

  const row = updated.rows[0];
  if (!row) {
    throw new MembershipError('TARGET_NOT_MEMBER', 'Server not found');
  }

  return mapServerAiSettingsRow(row);
}

export async function addMemberByUsername(serverId: string, username: string, actorUserId: string) {
  const actorRole = await getMembershipRole(serverId, actorUserId);
  if (actorRole !== 'owner') {
    throw new Error('Only owners can add members');
  }

  const user = await findUserByUsername(username);
  if (!user) {
    return null;
  }

  await addServerMembership(serverId, user.id, 'member');
  return { userId: user.id, username: user.username };
}

export async function createMessageAttachment(attachment: {
  id: string;
  uploadedByUserId: string;
  fileName: string;
  mimeType: string;
  category: AttachmentCategory;
  sizeBytes: number;
  storagePath: string;
}) {
  const inserted = await pool.query<MessageAttachmentRow>(
    `
      INSERT INTO message_attachments (id, uploaded_by_user_id, file_name, mime_type, size_bytes, storage_path)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, file_name, mime_type, size_bytes, storage_path;
    `,
    [
      attachment.id,
      attachment.uploadedByUserId,
      attachment.fileName,
      attachment.mimeType,
      attachment.sizeBytes,
      attachment.storagePath,
    ],
  );

  return mapAttachmentRow(inserted.rows[0]);
}

export async function listMessageAttachmentsByIds(attachmentIds: string[], userId: string) {
  if (attachmentIds.length === 0) {
    return [];
  }

  const rows = await pool.query<MessageAttachmentRow>(
    `
      SELECT id, file_name, mime_type, size_bytes, storage_path
      FROM message_attachments
      WHERE uploaded_by_user_id = $2
        AND id = ANY($1::uuid[])
      ORDER BY created_at ASC;
    `,
    [attachmentIds, userId],
  );

  return rows.rows.map(mapAttachmentRow);
}

export async function saveMessage(message: {
  id: string;
  channelId: string;
  userId?: string | null;
  user: string;
  text: string;
  createdAt: string;
  attachmentIds?: string[];
}) {
  await pool.query('BEGIN');

  try {
    const inserted = await pool.query<ChatMessageRow>(
      `
        INSERT INTO chat_messages (id, channel_id, user_id, user_name, text, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, channel_id, user_id, user_name, text, created_at, edited_at;
      `,
      [
        message.id,
        message.channelId,
        message.userId ?? null,
        message.user,
        message.text,
        message.createdAt,
      ],
    );

    if (message.attachmentIds && message.attachmentIds.length > 0) {
      await pool.query(
        `
          INSERT INTO chat_message_attachments (message_id, attachment_id)
          SELECT $1, attachment.id
          FROM message_attachments attachment
          WHERE attachment.id = ANY($2::uuid[])
            AND attachment.uploaded_by_user_id = $3;
        `,
        [message.id, message.attachmentIds, message.userId ?? null],
      );
    }

    await pool.query('COMMIT');

    const attachments = await listMessageAttachmentsByIds(
      message.attachmentIds ?? [],
      message.userId ?? '',
    );
    return mapRow(inserted.rows[0], attachments);
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
}

export async function fetchChannelMessagesPage(
  channelId: string,
  options: CursorPaginationOptions = {},
): Promise<MessagePage<ChatMessage>> {
  const safeLimit = Math.max(1, Math.min(options.limit ?? chatHistoryLimit, 500));
  const safeOffset = Math.max(0, Math.min(options.offset ?? 0, 5_000));
  const beforeCursor = parseCursorOrThrow(options.before, 'before');
  const afterCursor = parseCursorOrThrow(options.after, 'after');

  const rows = await pool.query<ChatMessageRow>(
    `
      SELECT id, channel_id, user_id, user_name, text, created_at, edited_at
      FROM chat_messages
      WHERE channel_id = $1
        AND (
          ($2::timestamptz IS NULL AND $3::uuid IS NULL)
          OR (created_at, id) < ($2::timestamptz, $3::uuid)
        )
        AND (
          ($4::timestamptz IS NULL AND $5::uuid IS NULL)
          OR (created_at, id) > ($4::timestamptz, $5::uuid)
        )
      ORDER BY created_at DESC, id DESC
      LIMIT $6
      OFFSET $7;
    `,
    [
      channelId,
      beforeCursor?.createdAt ?? null,
      beforeCursor?.id ?? null,
      afterCursor?.createdAt ?? null,
      afterCursor?.id ?? null,
      safeLimit,
      safeOffset,
    ],
  );

  const descending = rows.rows;
  const messages = descending.slice().reverse();
  const attachmentsByMessageId = await fetchAttachmentsForMessages(messages.map((message) => message.id));
  const mapped = messages.map((message) => mapRow(message, attachmentsByMessageId.get(message.id) ?? []));

  return {
    messages: mapped,
    nextCursor:
      descending.length > 0
        ? encodeCursorToken(toCursor(descending[descending.length - 1].created_at, descending[descending.length - 1].id))
        : null,
    prevCursor:
      descending.length > 0
        ? encodeCursorToken(toCursor(descending[0].created_at, descending[0].id))
        : null,
  };
}

export async function fetchRecentMessages(channelId: string, limit = chatHistoryLimit) {
  const page = await fetchChannelMessagesPage(channelId, { limit });
  return page.messages;
}

export async function updateMessageById(messageId: string, actorUserId: string, newText: string) {
  const updated = await pool.query<{
    id: string;
    channel_id: string;
    server_id: string;
    user_id: string | null;
    user_name: string;
    text: string;
    created_at: Date | string;
    edited_at: Date | string | null;
    can_edit: boolean;
  }>(
    `
      WITH target AS (
        SELECT
          m.id,
          m.channel_id,
          c.server_id,
          m.user_id,
          m.user_name,
          m.text,
          m.created_at,
          m.edited_at,
          EXISTS (
            SELECT 1
            FROM server_memberships sm
            WHERE sm.server_id = c.server_id
              AND sm.user_id = $2
              AND sm.role = 'owner'
          ) OR m.user_id = $2 AS can_edit
        FROM chat_messages m
        INNER JOIN channels c ON c.id = m.channel_id
        WHERE m.id = $1
      ),
      edited AS (
        UPDATE chat_messages
        SET text = $3, edited_at = NOW()
        WHERE id = $1 AND EXISTS (SELECT 1 FROM target WHERE can_edit)
        RETURNING id
      )
      SELECT
        target.id,
        target.channel_id,
        target.server_id,
        target.user_id,
        target.user_name,
        $3 AS text,
        target.created_at,
        NOW() AS edited_at,
        target.can_edit
      FROM target
      INNER JOIN edited ON edited.id = target.id;
    `,
    [messageId, actorUserId, newText],
  );

  return updated.rows[0] ?? null;
}

export async function deleteMessageById(messageId: string, actorUserId: string) {
  const deleted = await pool.query<{
    id: string;
    channel_id: string;
    server_id: string;
    user_id: string | null;
    user_name: string;
    text: string;
    created_at: Date | string;
    can_delete: boolean;
  }>(
    `
      WITH target AS (
        SELECT
          m.id,
          m.channel_id,
          c.server_id,
          m.user_id,
          m.user_name,
          m.text,
          m.created_at,
          EXISTS (
            SELECT 1
            FROM server_memberships sm
            WHERE sm.server_id = c.server_id
              AND sm.user_id = $2
              AND sm.role = 'owner'
          ) OR m.user_id = $2 AS can_delete
        FROM chat_messages m
        INNER JOIN channels c ON c.id = m.channel_id
        WHERE m.id = $1
      ),
      removed AS (
        DELETE FROM chat_messages
        WHERE id = $1 AND EXISTS (SELECT 1 FROM target WHERE can_delete)
        RETURNING id
      )
      SELECT
        target.id,
        target.channel_id,
        target.server_id,
        target.user_id,
        target.user_name,
        target.text,
        target.created_at,
        target.can_delete
      FROM target
      INNER JOIN removed ON removed.id = target.id;
    `,
    [messageId, actorUserId],
  );

  return deleted.rows[0] ?? null;
}

export async function reportMessageById(messageId: string, actorUserId: string) {
  const result = await pool.query<{
    id: string;
    channel_id: string;
    server_id: string;
    user_id: string | null;
    user_name: string;
    text: string;
    created_at: Date | string;
  }>(
    `
      SELECT m.id, m.channel_id, c.server_id, m.user_id, m.user_name, m.text, m.created_at
      FROM chat_messages m
      INNER JOIN channels c ON c.id = m.channel_id
      WHERE m.id = $1
        AND EXISTS (
          SELECT 1
          FROM server_memberships sm
          WHERE sm.server_id = c.server_id AND sm.user_id = $2
        );
    `,
    [messageId, actorUserId],
  );

  return result.rows[0] ?? null;
}



export class MembershipError extends Error {
  code: 'ACTOR_NOT_MEMBER' | 'ACTOR_NOT_OWNER' | 'TARGET_NOT_MEMBER';

  constructor(code: 'ACTOR_NOT_MEMBER' | 'ACTOR_NOT_OWNER' | 'TARGET_NOT_MEMBER', message: string) {
    super(message);
    this.code = code;
  }
}

export async function muteUserInServer(
  serverId: string,
  targetUserId: string,
  actorUserId: string,
  reason: string | null,
) {
  const actorRole = await getMembershipRole(serverId, actorUserId);
  if (!actorRole) {
    throw new MembershipError('ACTOR_NOT_MEMBER', 'Actor is not a member of this server');
  }

  if (actorRole !== 'owner') {
    throw new MembershipError('ACTOR_NOT_OWNER', 'Only owners can mute users');
  }

  const targetMembership = await isMemberOfServer(serverId, targetUserId);
  if (!targetMembership) {
    throw new MembershipError('TARGET_NOT_MEMBER', 'Target user is not a member of this server');
  }

  await pool.query(
    `
      INSERT INTO server_mutes (server_id, user_id, muted_by_user_id, reason)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (server_id, user_id)
      DO UPDATE SET muted_by_user_id = EXCLUDED.muted_by_user_id, reason = EXCLUDED.reason, created_at = NOW();
    `,
    [serverId, targetUserId, actorUserId, reason],
  );
}



export async function unmuteUserInServer(serverId: string, targetUserId: string, actorUserId: string) {
  const actorRole = await getMembershipRole(serverId, actorUserId);
  if (!actorRole) {
    throw new MembershipError('ACTOR_NOT_MEMBER', 'Actor is not a member of this server');
  }

  if (actorRole !== 'owner') {
    throw new MembershipError('ACTOR_NOT_OWNER', 'Only owners can unmute users');
  }

  const targetMembership = await isMemberOfServer(serverId, targetUserId);
  if (!targetMembership) {
    throw new MembershipError('TARGET_NOT_MEMBER', 'Target user is not a member of this server');
  }

  await pool.query(
    `
      DELETE FROM server_mutes
      WHERE server_id = $1 AND user_id = $2;
    `,
    [serverId, targetUserId],
  );
}

export async function updateMemberScreenSharePermission(
  serverId: string,
  targetUserId: string,
  canShare: boolean,
  actorUserId: string,
) {
  const actorRole = await getMembershipRole(serverId, actorUserId);
  if (!actorRole) {
    throw new MembershipError('ACTOR_NOT_MEMBER', 'Actor is not a member of this server');
  }

  if (actorRole !== 'owner') {
    throw new MembershipError('ACTOR_NOT_OWNER', 'Only owners can update member permissions');
  }

  const updated = await pool.query<{ user_id: string }>(
    `
      UPDATE server_memberships
      SET can_share_screen = $3
      WHERE server_id = $1 AND user_id = $2
      RETURNING user_id;
    `,
    [serverId, targetUserId, canShare],
  );

  if (!updated.rowCount) {
    throw new MembershipError('TARGET_NOT_MEMBER', 'Target user is not a member of this server');
  }
}

export async function isMutedInServer(serverId: string, userId: string) {
  const result = await pool.query<{ found: number }>(
    `
      SELECT 1 AS found
      FROM server_mutes
      WHERE server_id = $1 AND user_id = $2;
    `,
    [serverId, userId],
  );

  return Boolean(result.rowCount);
}

export async function writeModerationAuditLog(entry: {
  id: string;
  serverId: string;
  actorUserId: string;
  targetUserId?: string | null;
  messageId?: string | null;
  action:
    | 'message_delete'
    | 'message_report'
    | 'user_mute'
    | 'user_unmute'
    | 'member_permission_update'
    | 'screen_share_start'
    | 'screen_share_stop'
    | 'screen_share_force_stop'
    | 'message_edit';
  details?: unknown;
}) {
  await pool.query(
    `
      INSERT INTO moderation_audit_logs (id, server_id, actor_user_id, target_user_id, message_id, action, details)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb);
    `,
    [
      entry.id,
      entry.serverId,
      entry.actorUserId,
      entry.targetUserId ?? null,
      entry.messageId ?? null,
      entry.action,
      JSON.stringify(entry.details ?? {}),
    ],
  );
}

export async function listModerationAuditLogs(serverId: string, userId: string, limit = 50) {
  const role = await getMembershipRole(serverId, userId);
  if (role !== 'owner') {
    throw new Error('Only owners can view moderation logs');
  }

  const safeLimit = Math.max(1, Math.min(limit, 200));
  const result = await pool.query<{
    id: string;
    server_id: string;
    actor_user_id: string;
    actor_username: string;
    target_user_id: string | null;
    target_username: string | null;
    message_id: string | null;
    action:
      | 'message_delete'
      | 'message_report'
      | 'user_mute'
      | 'user_unmute'
      | 'member_permission_update'
      | 'screen_share_start'
      | 'screen_share_stop'
      | 'screen_share_force_stop'
      | 'message_edit';
    details: unknown;
    created_at: Date | string;
  }>(
    `
      SELECT
        l.id,
        l.server_id,
        l.actor_user_id,
        actor.username AS actor_username,
        l.target_user_id,
        target.username AS target_username,
        l.message_id,
        l.action,
        l.details,
        l.created_at
      FROM moderation_audit_logs l
      INNER JOIN users actor ON actor.id = l.actor_user_id
      LEFT JOIN users target ON target.id = l.target_user_id
      WHERE l.server_id = $1
      ORDER BY l.created_at DESC
      LIMIT $2;
    `,
    [serverId, safeLimit],
  );

  return result.rows.map((row) => ({
    id: row.id,
    serverId: row.server_id,
    actorUserId: row.actor_user_id,
    actorUsername: row.actor_username,
    targetUserId: row.target_user_id,
    targetUsername: row.target_username,
    messageId: row.message_id,
    action: row.action,
    details: row.details,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}



export async function upsertChannelWatchSession(channelId: string, state: CoWatchPlaybackState) {
  await pool.query(
    `
      INSERT INTO channel_watch_sessions (
        channel_id,
        host_user_id,
        controllers,
        media_source_type,
        media_url,
        media_title,
        paused,
        position_sec,
        last_event_at,
        updated_at
      )
      VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, NOW())
      ON CONFLICT (channel_id) DO UPDATE SET
        host_user_id = EXCLUDED.host_user_id,
        controllers = EXCLUDED.controllers,
        media_source_type = EXCLUDED.media_source_type,
        media_url = EXCLUDED.media_url,
        media_title = EXCLUDED.media_title,
        paused = EXCLUDED.paused,
        position_sec = EXCLUDED.position_sec,
        last_event_at = EXCLUDED.last_event_at,
        updated_at = NOW();
    `,
    [
      channelId,
      state.hostUserId,
      JSON.stringify(state.controllers),
      state.media.sourceType,
      state.media.url,
      state.media.title ?? null,
      state.paused,
      state.positionSec,
      state.lastEventAt,
    ],
  );
}

export async function getChannelWatchSession(channelId: string): Promise<CoWatchPlaybackState | null> {
  const result = await pool.query<WatchSessionRow>(
    `
      SELECT
        channel_id,
        host_user_id,
        controllers,
        media_source_type,
        media_url,
        media_title,
        paused,
        position_sec,
        last_event_at
      FROM channel_watch_sessions
      WHERE channel_id = $1;
    `,
    [channelId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    hostUserId: row.host_user_id,
    controllers: Array.isArray(row.controllers) ? row.controllers : [],
    media: {
      sourceType: row.media_source_type,
      url: row.media_url,
      title: row.media_title ?? undefined,
    },
    paused: row.paused,
    positionSec: Number(row.position_sec) || 0,
    lastEventAt: new Date(row.last_event_at).toISOString(),
  };
}
export async function closeDb() {
  await pool.end();
}

export async function createOrGetDmThread(userAId: string, userBId: string) {
  if (userAId === userBId) {
    throw new Error('Cannot create DM with self');
  }

  const result = await pool.query<{ id: string }>(
    `
      INSERT INTO dm_threads (id, user_a_id, user_b_id)
      VALUES ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid))
      ON CONFLICT ((LEAST(user_a_id, user_b_id)), (GREATEST(user_a_id, user_b_id))) DO UPDATE
      SET user_a_id = dm_threads.user_a_id
      RETURNING id;
    `,
    [crypto.randomUUID(), userAId, userBId],
  );

  return result.rows[0].id;
}

export async function listDmThreadsForUser(userId: string) {
  const result = await pool.query<DmThreadRow>(
    `
      SELECT
        t.id,
        t.user_a_id,
        t.user_b_id,
        CASE WHEN t.user_a_id = $1 THEN t.user_b_id ELSE t.user_a_id END AS other_user_id,
        other_user.username AS other_username,
        MAX(m.created_at) AS last_message_at
      FROM dm_threads t
      INNER JOIN users other_user
        ON other_user.id = CASE WHEN t.user_a_id = $1 THEN t.user_b_id ELSE t.user_a_id END
      LEFT JOIN dm_messages m ON m.thread_id = t.id
      WHERE t.user_a_id = $1 OR t.user_b_id = $1
      GROUP BY t.id, t.user_a_id, t.user_b_id, other_user.id, other_user.username
      ORDER BY COALESCE(MAX(m.created_at), t.created_at) DESC;
    `,
    [userId],
  );

  return result.rows.map(mapDmThreadRow);
}

export async function canAccessDmThread(threadId: string, userId: string) {
  const result = await pool.query<{ found: number }>(
    `
      SELECT 1 AS found
      FROM dm_threads
      WHERE id = $1 AND (user_a_id = $2 OR user_b_id = $2);
    `,
    [threadId, userId],
  );

  return Boolean(result.rowCount);
}

export async function saveDmMessage(message: DmMessage) {
  const inserted = await pool.query<DmMessageRow>(
    `
      WITH inserted AS (
        INSERT INTO dm_messages (id, thread_id, sender_user_id, text, created_at)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, thread_id, sender_user_id, text, created_at
      )
      SELECT
        inserted.id,
        inserted.thread_id,
        inserted.sender_user_id,
        users.username AS sender_username,
        inserted.text,
        inserted.created_at
      FROM inserted
      INNER JOIN users ON users.id = inserted.sender_user_id;
    `,
    [message.id, message.threadId, message.senderUserId, message.text, message.createdAt],
  );

  return mapDmMessageRow(inserted.rows[0]);
}

export async function fetchDmMessagesPage(
  threadId: string,
  options: CursorPaginationOptions = {},
): Promise<MessagePage<DmMessage>> {
  const safeLimit = Math.max(1, Math.min(options.limit ?? chatHistoryLimit, 500));
  const safeOffset = Math.max(0, Math.min(options.offset ?? 0, 5_000));
  const beforeCursor = parseCursorOrThrow(options.before, 'before');
  const afterCursor = parseCursorOrThrow(options.after, 'after');

  const rows = await pool.query<DmMessageRow>(
    `
      SELECT
        dm_messages.id,
        dm_messages.thread_id,
        dm_messages.sender_user_id,
        users.username AS sender_username,
        dm_messages.text,
        dm_messages.created_at
      FROM dm_messages
      INNER JOIN users ON users.id = dm_messages.sender_user_id
      WHERE dm_messages.thread_id = $1
        AND (
          ($2::timestamptz IS NULL AND $3::uuid IS NULL)
          OR (dm_messages.created_at, dm_messages.id) < ($2::timestamptz, $3::uuid)
        )
        AND (
          ($4::timestamptz IS NULL AND $5::uuid IS NULL)
          OR (dm_messages.created_at, dm_messages.id) > ($4::timestamptz, $5::uuid)
        )
      ORDER BY dm_messages.created_at DESC, dm_messages.id DESC
      LIMIT $6
      OFFSET $7;
    `,
    [
      threadId,
      beforeCursor?.createdAt ?? null,
      beforeCursor?.id ?? null,
      afterCursor?.createdAt ?? null,
      afterCursor?.id ?? null,
      safeLimit,
      safeOffset,
    ],
  );

  const descending = rows.rows;
  return {
    messages: descending.slice().reverse().map(mapDmMessageRow),
    nextCursor:
      descending.length > 0
        ? encodeCursorToken(toCursor(descending[descending.length - 1].created_at, descending[descending.length - 1].id))
        : null,
    prevCursor:
      descending.length > 0
        ? encodeCursorToken(toCursor(descending[0].created_at, descending[0].id))
        : null,
  };
}

export async function fetchRecentDmMessages(threadId: string, limit = chatHistoryLimit) {
  const page = await fetchDmMessagesPage(threadId, { limit });
  return page.messages;
}

export async function searchChannelMessagesPage(
  channelId: string,
  query: string,
  options: CursorPaginationOptions = {},
): Promise<MessagePage<ChatMessage>> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return { messages: [], nextCursor: null, prevCursor: null };
  }

  const safeLimit = Math.max(1, Math.min(options.limit ?? 25, 100));
  const safeOffset = Math.max(0, Math.min(options.offset ?? 0, 5_000));
  const beforeCursor = parseCursorOrThrow(options.before, 'before');
  const afterCursor = parseCursorOrThrow(options.after, 'after');
  const rows = await pool.query<SearchMessageRow>(
    `
      SELECT id, channel_id, user_id, user_name, text, created_at, edited_at
      FROM chat_messages
      WHERE channel_id = $1
        AND to_tsvector('simple', coalesce(text, '')) @@ plainto_tsquery('simple', $2)
        AND (
          ($3::timestamptz IS NULL AND $4::uuid IS NULL)
          OR (created_at, id) < ($3::timestamptz, $4::uuid)
        )
        AND (
          ($5::timestamptz IS NULL AND $6::uuid IS NULL)
          OR (created_at, id) > ($5::timestamptz, $6::uuid)
        )
      ORDER BY created_at DESC, id DESC
      LIMIT $7
      OFFSET $8;
    `,
    [
      channelId,
      normalizedQuery,
      beforeCursor?.createdAt ?? null,
      beforeCursor?.id ?? null,
      afterCursor?.createdAt ?? null,
      afterCursor?.id ?? null,
      safeLimit,
      safeOffset,
    ],
  );

  const attachmentsByMessageId = await fetchAttachmentsForMessages(rows.rows.map((row) => row.id));
  const mapped = rows.rows.map((row) => mapRow(row, attachmentsByMessageId.get(row.id) ?? []));
  return {
    messages: mapped,
    nextCursor:
      rows.rows.length > 0
        ? encodeCursorToken(toCursor(rows.rows[rows.rows.length - 1].created_at, rows.rows[rows.rows.length - 1].id))
        : null,
    prevCursor:
      rows.rows.length > 0
        ? encodeCursorToken(toCursor(rows.rows[0].created_at, rows.rows[0].id))
        : null,
  };
}

export async function searchChannelMessages(
  channelId: string,
  query: string,
  limit = 25,
  offset = 0,
) {
  const page = await searchChannelMessagesPage(channelId, query, { limit, offset });
  return page.messages;
}

export async function searchDmMessagesPage(
  threadId: string,
  query: string,
  options: CursorPaginationOptions = {},
): Promise<MessagePage<DmMessage>> {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return { messages: [], nextCursor: null, prevCursor: null };
  }

  const safeLimit = Math.max(1, Math.min(options.limit ?? 25, 100));
  const safeOffset = Math.max(0, Math.min(options.offset ?? 0, 5_000));
  const beforeCursor = parseCursorOrThrow(options.before, 'before');
  const afterCursor = parseCursorOrThrow(options.after, 'after');
  const rows = await pool.query<SearchDmMessageRow>(
    `
      SELECT
        dm_messages.id,
        dm_messages.thread_id,
        dm_messages.sender_user_id,
        users.username AS sender_username,
        dm_messages.text,
        dm_messages.created_at
      FROM dm_messages
      INNER JOIN users ON users.id = dm_messages.sender_user_id
      WHERE dm_messages.thread_id = $1
        AND to_tsvector('simple', coalesce(dm_messages.text, '')) @@ plainto_tsquery('simple', $2)
        AND (
          ($3::timestamptz IS NULL AND $4::uuid IS NULL)
          OR (dm_messages.created_at, dm_messages.id) < ($3::timestamptz, $4::uuid)
        )
        AND (
          ($5::timestamptz IS NULL AND $6::uuid IS NULL)
          OR (dm_messages.created_at, dm_messages.id) > ($5::timestamptz, $6::uuid)
        )
      ORDER BY dm_messages.created_at DESC, dm_messages.id DESC
      LIMIT $7
      OFFSET $8;
    `,
    [
      threadId,
      normalizedQuery,
      beforeCursor?.createdAt ?? null,
      beforeCursor?.id ?? null,
      afterCursor?.createdAt ?? null,
      afterCursor?.id ?? null,
      safeLimit,
      safeOffset,
    ],
  );

  return {
    messages: rows.rows.map(mapDmMessageRow),
    nextCursor:
      rows.rows.length > 0
        ? encodeCursorToken(toCursor(rows.rows[rows.rows.length - 1].created_at, rows.rows[rows.rows.length - 1].id))
        : null,
    prevCursor:
      rows.rows.length > 0
        ? encodeCursorToken(toCursor(rows.rows[0].created_at, rows.rows[0].id))
        : null,
  };
}

export async function searchDmMessages(threadId: string, query: string, limit = 25, offset = 0) {
  const page = await searchDmMessagesPage(threadId, query, { limit, offset });
  return page.messages;
}

async function resolveChannelReadReference(channelId: string, lastReadMessageId?: string | null) {
  if (!lastReadMessageId) {
    const latest = await pool.query<{ id: string; created_at: Date | string }>(
      `
        SELECT id, created_at
        FROM chat_messages
        WHERE channel_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1;
      `,
      [channelId],
    );
    return {
      lastReadMessageId: latest.rows[0]?.id ?? null,
      lastReadAt: latest.rows[0] ? new Date(latest.rows[0].created_at).toISOString() : null,
    };
  }

  const message = await pool.query<{ id: string; created_at: Date | string }>(
    `
      SELECT id, created_at
      FROM chat_messages
      WHERE id = $1 AND channel_id = $2;
    `,
    [lastReadMessageId, channelId],
  );

  if (!message.rowCount) {
    throw new Error('Message not found in channel');
  }

  return {
    lastReadMessageId: message.rows[0].id,
    lastReadAt: new Date(message.rows[0].created_at).toISOString(),
  };
}

async function resolveDmReadReference(threadId: string, lastReadMessageId?: string | null) {
  if (!lastReadMessageId) {
    const latest = await pool.query<{ id: string; created_at: Date | string }>(
      `
        SELECT id, created_at
        FROM dm_messages
        WHERE thread_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1;
      `,
      [threadId],
    );

    return {
      lastReadMessageId: latest.rows[0]?.id ?? null,
      lastReadAt: latest.rows[0] ? new Date(latest.rows[0].created_at).toISOString() : null,
    };
  }

  const message = await pool.query<{ id: string; created_at: Date | string }>(
    `
      SELECT id, created_at
      FROM dm_messages
      WHERE id = $1 AND thread_id = $2;
    `,
    [lastReadMessageId, threadId],
  );

  if (!message.rowCount) {
    throw new Error('Message not found in DM thread');
  }

  return {
    lastReadMessageId: message.rows[0].id,
    lastReadAt: new Date(message.rows[0].created_at).toISOString(),
  };
}

export async function markChannelAsRead(userId: string, channelId: string, lastReadMessageId?: string) {
  const readRef = await resolveChannelReadReference(channelId, lastReadMessageId);
  await pool.query(
    `
      INSERT INTO channel_read_markers (
        user_id,
        channel_id,
        last_read_message_id,
        last_read_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, channel_id)
      DO UPDATE
      SET
        last_read_at = GREATEST(
          COALESCE(channel_read_markers.last_read_at, '-infinity'::timestamptz),
          COALESCE(EXCLUDED.last_read_at, '-infinity'::timestamptz)
        ),
        last_read_message_id =
          CASE
            WHEN COALESCE(EXCLUDED.last_read_at, '-infinity'::timestamptz)
              >= COALESCE(channel_read_markers.last_read_at, '-infinity'::timestamptz)
            THEN EXCLUDED.last_read_message_id
            ELSE channel_read_markers.last_read_message_id
          END,
        updated_at = NOW();
    `,
    [userId, channelId, readRef.lastReadMessageId, readRef.lastReadAt],
  );
}

export async function markDmThreadAsRead(userId: string, threadId: string, lastReadMessageId?: string) {
  const readRef = await resolveDmReadReference(threadId, lastReadMessageId);
  await pool.query(
    `
      INSERT INTO dm_thread_read_markers (
        user_id,
        thread_id,
        last_read_message_id,
        last_read_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, thread_id)
      DO UPDATE
      SET
        last_read_at = GREATEST(
          COALESCE(dm_thread_read_markers.last_read_at, '-infinity'::timestamptz),
          COALESCE(EXCLUDED.last_read_at, '-infinity'::timestamptz)
        ),
        last_read_message_id =
          CASE
            WHEN COALESCE(EXCLUDED.last_read_at, '-infinity'::timestamptz)
              >= COALESCE(dm_thread_read_markers.last_read_at, '-infinity'::timestamptz)
            THEN EXCLUDED.last_read_message_id
            ELSE dm_thread_read_markers.last_read_message_id
          END,
        updated_at = NOW();
    `,
    [userId, threadId, readRef.lastReadMessageId, readRef.lastReadAt],
  );
}

export async function getUnreadSummary(userId: string): Promise<UnreadSummary> {
  const channelRows = await pool.query<{ channel_id: string; unread_count: string }>(
    `
      SELECT
        channel_messages.channel_id,
        COUNT(*)::text AS unread_count
      FROM chat_messages channel_messages
      INNER JOIN channels c ON c.id = channel_messages.channel_id
      INNER JOIN server_memberships sm ON sm.server_id = c.server_id AND sm.user_id = $1
      LEFT JOIN channel_read_markers marker
        ON marker.user_id = $1
       AND marker.channel_id = channel_messages.channel_id
      WHERE COALESCE(channel_messages.user_id, '') <> $1
        AND (
          marker.last_read_at IS NULL
          OR channel_messages.created_at > marker.last_read_at
        )
      GROUP BY channel_messages.channel_id;
    `,
    [userId],
  );

  const dmRows = await pool.query<{ thread_id: string; unread_count: string }>(
    `
      SELECT
        messages.thread_id,
        COUNT(*)::text AS unread_count
      FROM dm_messages messages
      INNER JOIN dm_threads t ON t.id = messages.thread_id
      LEFT JOIN dm_thread_read_markers marker
        ON marker.user_id = $1
       AND marker.thread_id = messages.thread_id
      WHERE (t.user_a_id = $1 OR t.user_b_id = $1)
        AND messages.sender_user_id <> $1
        AND (
          marker.last_read_at IS NULL
          OR messages.created_at > marker.last_read_at
        )
      GROUP BY messages.thread_id;
    `,
    [userId],
  );

  const channels = Object.fromEntries(
    channelRows.rows.map((row) => [row.channel_id, Number.parseInt(row.unread_count, 10)]),
  );
  const dmThreads = Object.fromEntries(
    dmRows.rows.map((row) => [row.thread_id, Number.parseInt(row.unread_count, 10)]),
  );

  return {
    channels,
    dmThreads,
    totalChannels: Object.values(channels).reduce((sum, value) => sum + value, 0),
    totalDmThreads: Object.values(dmThreads).reduce((sum, value) => sum + value, 0),
  };
}
