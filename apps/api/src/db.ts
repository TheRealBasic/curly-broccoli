import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { ChatMessage } from '@curly-broccoli/shared';

const DEFAULT_HISTORY_LIMIT = 50;

export const chatHistoryLimit = Number(process.env.CHAT_HISTORY_LIMIT ?? DEFAULT_HISTORY_LIMIT);

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to start the API.');
}

const pool = new Pool({
  connectionString: databaseUrl
});

type ChatMessageRow = {
  id: string;
  user_name: string;
  text: string;
  created_at: Date | string;
};

function mapRow(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    user: row.user_name,
    text: row.text,
    createdAt: new Date(row.created_at).toISOString()
  };
}

export async function runMigrations() {
  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `
  );

  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const migrationsDir = path.resolve(currentDir, '../migrations');
  const migrationFiles = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();

  for (const filename of migrationFiles) {
    const alreadyApplied = await pool.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations WHERE filename = $1',
      [filename]
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

export async function saveMessage(message: ChatMessage) {
  const inserted = await pool.query<ChatMessageRow>(
    `
      INSERT INTO chat_messages (id, user_name, text, created_at)
      VALUES ($1, $2, $3, $4)
      RETURNING id, user_name, text, created_at;
    `,
    [message.id, message.user, message.text, message.createdAt]
  );

  return mapRow(inserted.rows[0]);
}

export async function fetchRecentMessages(limit = chatHistoryLimit) {
  const safeLimit = Math.max(1, Math.min(limit, 500));
  const rows = await pool.query<ChatMessageRow>(
    `
      SELECT id, user_name, text, created_at
      FROM chat_messages
      ORDER BY created_at DESC
      LIMIT $1;
    `,
    [safeLimit]
  );

  return rows.rows.reverse().map(mapRow);
}

export async function closeDb() {
  await pool.end();
}
