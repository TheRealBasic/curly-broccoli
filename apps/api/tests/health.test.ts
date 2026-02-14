import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createAccessToken } from '../src/auth.js';
import type {
  ChannelSummary,
  ChatMessage,
  DmMessage,
  DmThreadSummary,
  ServerSummary,
} from '@curly-broccoli/shared';

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
});

const baseDeps = {
  fetchRecentMessages: vi
    .fn<(channelId: string) => Promise<{ messages: ChatMessage[]; nextCursor: string | null; prevCursor: string | null }>>()
    .mockResolvedValue({ messages: [], nextCursor: null, prevCursor: null }),
  findUserByUsername: vi.fn(),
  findUserById: vi.fn(),
  createUser: vi.fn(),
  storeRefreshToken: vi.fn().mockResolvedValue(undefined),
  findRefreshToken: vi.fn(),
  revokeRefreshToken: vi.fn().mockResolvedValue(undefined),
  listServersForUser: vi.fn<() => Promise<ServerSummary[]>>().mockResolvedValue([]),
  createServer: vi.fn(),
  addServerMembership: vi.fn().mockResolvedValue(undefined),
  listChannelsForServer: vi.fn<() => Promise<ChannelSummary[]>>().mockResolvedValue([]),
  createChannel: vi.fn(),
  addMemberByUsername: vi.fn(),
  listServerMembers: vi.fn().mockResolvedValue([]),
  createOrGetDmThread: vi.fn<() => Promise<string>>().mockResolvedValue('thread-1'),
  listDmThreadsForUser: vi.fn<() => Promise<DmThreadSummary[]>>().mockResolvedValue([]),
  fetchRecentDmMessages: vi
    .fn<() => Promise<{ messages: DmMessage[]; nextCursor: string | null; prevCursor: string | null }>>()
    .mockResolvedValue({ messages: [], nextCursor: null, prevCursor: null }),
  searchChannelMessages: vi
    .fn<(channelId: string) => Promise<{ messages: ChatMessage[]; nextCursor: string | null; prevCursor: string | null }>>()
    .mockResolvedValue({ messages: [], nextCursor: null, prevCursor: null }),
  searchDmMessages: vi
    .fn<(threadId: string) => Promise<{ messages: DmMessage[]; nextCursor: string | null; prevCursor: string | null }>>()
    .mockResolvedValue({ messages: [], nextCursor: null, prevCursor: null }),
  canAccessDmThread: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  canAccessChannel: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  createMessageAttachment: vi.fn().mockResolvedValue({
    id: 'attachment-1',
    fileName: 'upload.bin',
    mimeType: 'application/octet-stream',
    category: 'other',
    sizeBytes: 10,
    url: '/uploads/upload.bin',
  }),
  deleteMessageById: vi.fn(),
  updateMessageById: vi.fn(),
  reportMessageById: vi.fn(),
  muteUserInServer: vi.fn(),
  unmuteUserInServer: vi.fn(),
  updateMemberScreenSharePermission: vi.fn(),
  listModerationAuditLogs: vi.fn().mockResolvedValue([]),
  writeModerationAuditLog: vi.fn(),
  notifyMessageEdited: vi.fn(),
};

describe('GET /health', () => {
  it('returns ok payload', async () => {
    const { createApp } = await import('../src/app.js');
    const app = createApp(baseDeps);
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: 'api' });
  });
});

describe('GET /metrics', () => {
  it('returns basic uptime and request counters', async () => {
    const { createApp } = await import('../src/app.js');
    const app = createApp(baseDeps);

    await request(app).get('/health');
    const metricsRes = await request(app).get('/metrics');

    expect(metricsRes.status).toBe(200);
    expect(metricsRes.body.ok).toBe(true);
    expect(metricsRes.body.requests.total).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /messages', () => {
  it('requires bearer token', async () => {
    const { createApp } = await import('../src/app.js');
    const app = createApp(baseDeps);

    const res = await request(app).get('/messages?channelId=test-channel&limit=10');

    expect(res.status).toBe(401);
  });
});

describe('POST /auth/register and /auth/login', () => {
  it('registers and returns token payload', async () => {
    const { createApp } = await import('../src/app.js');
    const findUserByUsername = vi.fn().mockResolvedValue(null);
    const createUser = vi.fn().mockResolvedValue({
      id: 'user-1',
      username: 'alice',
      password_hash: 'x',
    });

    const app = createApp({
      ...baseDeps,
      findUserByUsername,
      createUser,
    });

    const res = await request(app)
      .post('/auth/register')
      .send({ username: 'alice', password: 'password123' });

    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe('alice');
    expect(res.body.tokens.accessToken).toBeTruthy();
    expect(res.body.tokens.refreshToken).toBeTruthy();
  });

  it('rejects invalid login', async () => {
    const { createApp } = await import('../src/app.js');
    const findUserByUsername = vi.fn().mockResolvedValue(null);
    const app = createApp({ ...baseDeps, findUserByUsername });

    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'missing', password: 'password123' });

    expect(res.status).toBe(401);
  });

  it('rate limits repeated auth attempts', async () => {
    const previousMax = process.env.AUTH_RATE_LIMIT_MAX;
    const previousWindow = process.env.AUTH_RATE_LIMIT_WINDOW_MS;
    process.env.AUTH_RATE_LIMIT_MAX = '1';
    process.env.AUTH_RATE_LIMIT_WINDOW_MS = '60000';

    try {
      const { createApp } = await import('../src/app.js');
      const findUserByUsername = vi.fn().mockResolvedValue(null);
      const app = createApp({ ...baseDeps, findUserByUsername });

      const first = await request(app)
        .post('/auth/login')
        .send({ username: 'missing', password: 'password123' });
      const second = await request(app)
        .post('/auth/login')
        .send({ username: 'missing', password: 'password123' });

      expect(first.status).toBe(401);
      expect(second.status).toBe(429);
    } finally {
      process.env.AUTH_RATE_LIMIT_MAX = previousMax;
      process.env.AUTH_RATE_LIMIT_WINDOW_MS = previousWindow;
    }
  });
});

describe('API permission checks', () => {
  it('blocks channel history when user cannot access channel', async () => {
    const { createApp } = await import('../src/app.js');
    const app = createApp({
      ...baseDeps,
      canAccessChannel: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    });

    const token = createAccessToken({ id: 'user-1', username: 'alice' });
    const res = await request(app)
      .get('/messages?channelId=channel-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  it('allows channel history when user can access channel', async () => {
    const { createApp } = await import('../src/app.js');
    const fetchRecentMessages = vi
      .fn<
        (channelId: string) => Promise<{ messages: ChatMessage[]; nextCursor: string | null; prevCursor: string | null }>
      >()
      .mockResolvedValue({ messages: [], nextCursor: null, prevCursor: null });
    const app = createApp({
      ...baseDeps,
      fetchRecentMessages,
      canAccessChannel: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    });

    const token = createAccessToken({ id: 'user-1', username: 'alice' });
    const res = await request(app)
      .get('/messages?channelId=channel-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(fetchRecentMessages).toHaveBeenCalledWith('channel-1', {
      limit: undefined,
      before: undefined,
      after: undefined,
      offset: undefined,
    });
  });

  it('blocks image uploads when user cannot access channel', async () => {
    const { createApp } = await import('../src/app.js');
    const app = createApp({
      ...baseDeps,
      canAccessChannel: vi.fn<() => Promise<boolean>>().mockResolvedValue(false),
    });

    const token = createAccessToken({ id: 'user-1', username: 'alice' });
    const res = await request(app)
      .post('/uploads/images')
      .set('Authorization', `Bearer ${token}`)
      .send({
        channelId: 'channel-1',
        fileName: 'screen.png',
        mimeType: 'image/png',
        fileDataBase64: Buffer.from('hello').toString('base64'),
      });

    expect(res.status).toBe(403);
  });



  it('uploads multipart attachments through the generalized endpoint', async () => {
    const { createApp } = await import('../src/app.js');
    const createMessageAttachment = vi.fn().mockResolvedValue({
      id: 'attachment-1',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      category: 'document',
      sizeBytes: 5,
      url: '/uploads/notes.txt',
    });
    const app = createApp({
      ...baseDeps,
      createMessageAttachment,
    });

    const token = createAccessToken({ id: 'user-1', username: 'alice' });
    const res = await request(app)
      .post('/uploads/attachments')
      .set('Authorization', `Bearer ${token}`)
      .field('channelId', 'channel-1')
      .attach('file', Buffer.from('hello'), { filename: 'notes.txt', contentType: 'text/plain' });

    expect(res.status).toBe(201);
    expect(createMessageAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadedByUserId: 'user-1',
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        category: 'document',
      }),
    );
  });

  it('rejects multipart attachments with unsupported mime type', async () => {
    const { createApp } = await import('../src/app.js');
    const app = createApp(baseDeps);

    const token = createAccessToken({ id: 'user-1', username: 'alice' });
    const res = await request(app)
      .post('/uploads/attachments')
      .set('Authorization', `Bearer ${token}`)
      .field('channelId', 'channel-1')
      .attach('file', Buffer.from('ok'), { filename: 'archive.tar', contentType: 'model/gltf-binary' });

    expect(res.status).toBe(415);
  });


  it('rejects multipart attachments that exceed category size limits', async () => {
    const { createApp } = await import('../src/app.js');
    const app = createApp(baseDeps);

    const token = createAccessToken({ id: 'user-1', username: 'alice' });
    const res = await request(app)
      .post('/uploads/attachments')
      .set('Authorization', `Bearer ${token}`)
      .field('channelId', 'channel-1')
      .attach('file', Buffer.alloc(11 * 1024 * 1024, 1), {
        filename: 'large.txt',
        contentType: 'text/plain',
      });

    expect(res.status).toBe(400);
  });

  it('edits a message and writes audit log', async () => {
    const { createApp } = await import('../src/app.js');
    const updateMessageById = vi.fn().mockResolvedValue({
      id: 'msg-1',
      channel_id: 'channel-1',
      server_id: 'server-1',
      user_id: 'user-1',
      user_name: 'alice',
      text: 'edited text',
      created_at: new Date().toISOString(),
      edited_at: new Date('2024-01-01T00:00:00.000Z').toISOString(),
      can_edit: true,
    });
    const writeModerationAuditLog = vi.fn().mockResolvedValue(undefined);
    const notifyMessageEdited = vi.fn();
    const app = createApp({
      ...baseDeps,
      updateMessageById,
      writeModerationAuditLog,
      notifyMessageEdited,
    });

    const token = createAccessToken({ id: 'user-1', username: 'alice' });
    const res = await request(app)
      .patch('/messages/msg-1')
      .set('Authorization', `Bearer ${token}`)
      .send({ text: 'edited text' });

    expect(res.status).toBe(200);
    expect(res.body.message.text).toBe('edited text');
    expect(updateMessageById).toHaveBeenCalledWith('msg-1', 'user-1', 'edited text');
    expect(writeModerationAuditLog).toHaveBeenCalled();
    expect(notifyMessageEdited).toHaveBeenCalledWith({
      channelId: 'channel-1',
      messageId: 'msg-1',
      text: 'edited text',
      editedAt: '2024-01-01T00:00:00.000Z',
    });
  });

  it('accepts offset=0 for channel search pagination', async () => {
    const { createApp } = await import('../src/app.js');
    const searchChannelMessages = vi
      .fn<
        (
          channelId: string,
          query: string,
          options?: { limit?: number; before?: string; after?: string; offset?: number },
        ) => Promise<{ messages: ChatMessage[]; nextCursor: string | null; prevCursor: string | null }>
      >()
      .mockResolvedValue({ messages: [], nextCursor: null, prevCursor: null });
    const app = createApp({
      ...baseDeps,
      searchChannelMessages,
    });

    const token = createAccessToken({ id: 'user-1', username: 'alice' });
    const res = await request(app)
      .get('/messages/search?channelId=channel-1&query=test&offset=0')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(searchChannelMessages).toHaveBeenCalledWith('channel-1', 'test', {
      limit: undefined,
      offset: 0,
      before: undefined,
      after: undefined,
    });
  });

  it('unmutes a member and writes audit log', async () => {
    const { createApp } = await import('../src/app.js');
    const unmuteUserInServer = vi.fn().mockResolvedValue(undefined);
    const writeModerationAuditLog = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      ...baseDeps,
      unmuteUserInServer,
      writeModerationAuditLog,
    });

    const token = createAccessToken({ id: 'owner-1', username: 'alice' });
    const res = await request(app)
      .delete('/servers/server-1/mutes/member-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(204);
    expect(unmuteUserInServer).toHaveBeenCalledWith('server-1', 'member-1', 'owner-1');
    expect(writeModerationAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'server-1',
        actorUserId: 'owner-1',
        targetUserId: 'member-1',
        action: 'user_unmute',
      }),
    );
  });

  it('returns 404 when unmute target is not a member', async () => {
    const { createApp } = await import('../src/app.js');
    const unmuteUserInServer = vi.fn().mockRejectedValue({ code: 'TARGET_NOT_MEMBER' });
    const app = createApp({
      ...baseDeps,
      unmuteUserInServer,
    });

    const token = createAccessToken({ id: 'owner-1', username: 'alice' });
    const res = await request(app)
      .delete('/servers/server-1/mutes/missing-1')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
  });

  it('updates member screen share permission and writes audit log', async () => {
    const { createApp } = await import('../src/app.js');
    const updateMemberScreenSharePermission = vi.fn().mockResolvedValue(undefined);
    const writeModerationAuditLog = vi.fn().mockResolvedValue(undefined);
    const app = createApp({
      ...baseDeps,
      updateMemberScreenSharePermission,
      writeModerationAuditLog,
    });

    const token = createAccessToken({ id: 'owner-1', username: 'alice' });
    const res = await request(app)
      .patch('/servers/server-1/members/member-1/permissions')
      .set('Authorization', `Bearer ${token}`)
      .send({ canShareScreen: false });

    expect(res.status).toBe(200);
    expect(updateMemberScreenSharePermission).toHaveBeenCalledWith(
      'server-1',
      'member-1',
      false,
      'owner-1',
    );
    expect(writeModerationAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'member_permission_update',
        details: { canShareScreen: false },
      }),
    );
  });

  it('returns 400 for invalid permission payload', async () => {
    const { createApp } = await import('../src/app.js');
    const app = createApp(baseDeps);

    const token = createAccessToken({ id: 'owner-1', username: 'alice' });
    const res = await request(app)
      .patch('/servers/server-1/members/member-1/permissions')
      .set('Authorization', `Bearer ${token}`)
      .send({ canShareScreen: 'yes' });

    expect(res.status).toBe(400);
  });

});


describe('Cursor pagination boundaries', () => {
  it('returns cursor metadata when page has exact page size', async () => {
    const { createApp } = await import('../src/app.js');
    const messages = Array.from({ length: 2 }, (_, index) => ({
      id: `message-${index}`,
      channelId: 'channel-1',
      userId: 'user-1',
      user: 'alice',
      text: `text-${index}`,
      attachments: [],
      createdAt: `2024-01-01T00:00:0${index}.000Z`,
      editedAt: null,
    } satisfies ChatMessage));
    const searchChannelMessages = vi.fn().mockResolvedValue({
      messages,
      nextCursor: 'next-cursor',
      prevCursor: 'prev-cursor',
    });
    const app = createApp({ ...baseDeps, searchChannelMessages });

    const token = createAccessToken({ id: 'user-1', username: 'alice' });
    const res = await request(app)
      .get('/messages/search?channelId=channel-1&query=test&limit=2')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBe('next-cursor');
    expect(res.body.prevCursor).toBe('prev-cursor');
    expect(res.body.messages).toHaveLength(2);
  });

  it('passes duplicate timestamp cursor tokens without dropping records', async () => {
    const { createApp } = await import('../src/app.js');
    const searchDmMessages = vi.fn().mockResolvedValue({
      messages: [],
      nextCursor: null,
      prevCursor: null,
    });
    const app = createApp({ ...baseDeps, searchDmMessages });

    const token = createAccessToken({ id: 'user-1', username: 'alice' });
    const before = Buffer.from('2024-01-01T00:00:00.000Z|00000000-0000-0000-0000-000000000001').toString(
      'base64url',
    );
    const res = await request(app)
      .get(`/dm/messages/search?threadId=thread-1&query=test&before=${before}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(searchDmMessages).toHaveBeenCalledWith('thread-1', 'test', {
      limit: undefined,
      offset: undefined,
      before,
      after: undefined,
    });
  });

  it('returns empty page payload when no messages match', async () => {
    const { createApp } = await import('../src/app.js');
    const fetchRecentDmMessages = vi.fn().mockResolvedValue({
      messages: [],
      nextCursor: null,
      prevCursor: null,
    });
    const app = createApp({ ...baseDeps, fetchRecentDmMessages });

    const token = createAccessToken({ id: 'user-1', username: 'alice' });
    const res = await request(app)
      .get('/dm/messages?threadId=thread-1&limit=20')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ messages: [], nextCursor: null, prevCursor: null });
  });
});
