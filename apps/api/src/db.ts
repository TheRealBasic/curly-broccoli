import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type {
  ChannelSummary,
  ChatMessage,
  ServerMember,
  ServerSummary,
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
  user_name: string;
  text: string;
  created_at: Date | string;
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
};

function mapRow(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    user: row.user_name,
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
      RETURNING id, name, owner_id;
    `,
    [id, name, ownerId],
  );

  const server = inserted.rows[0];
  return { id: server.id, name: server.name, ownerId: server.owner_id } satisfies ServerSummary;
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
      SELECT s.id, s.name, s.owner_id
      FROM servers s
      INNER JOIN server_memberships sm ON sm.server_id = s.id
      WHERE sm.user_id = $1
      ORDER BY s.created_at ASC;
    `,
    [userId],
  );

  return result.rows.map(
    (row) => ({ id: row.id, name: row.name, ownerId: row.owner_id }) satisfies ServerSummary,
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
      SELECT sm.user_id, u.username, sm.role
      FROM server_memberships sm
      INNER JOIN users u ON u.id = sm.user_id
      WHERE sm.server_id = $1
      ORDER BY
        CASE WHEN sm.role = 'owner' THEN 0 ELSE 1 END ASC,
        u.username ASC;
    `,
    [serverId],
  );

  return result.rows.map(
    (row) =>
      ({ userId: row.user_id, username: row.username, role: row.role }) satisfies ServerMember,
  );
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

export async function saveMessage(message: ChatMessage) {
  const inserted = await pool.query<ChatMessageRow>(
    `
      INSERT INTO chat_messages (id, channel_id, user_name, text, created_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, channel_id, user_name, text, created_at;
    `,
    [message.id, message.channelId, message.user, message.text, message.createdAt],
  );

  return mapRow(inserted.rows[0]);
}

export async function fetchRecentMessages(channelId: string, limit = chatHistoryLimit) {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const rows = await pool.query<ChatMessageRow>(
    `
      SELECT id, channel_id, user_name, text, created_at
      FROM chat_messages
      WHERE channel_id = $1
      ORDER BY created_at DESC
      LIMIT $2;
    `,
    [channelId, safeLimit],
  );

  return rows.rows.reverse().map(mapRow);
}

export async function closeDb() {
  await pool.end();
}
