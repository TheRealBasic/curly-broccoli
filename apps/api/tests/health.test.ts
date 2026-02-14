import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
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
  fetchRecentMessages: vi.fn<(channelId: string) => Promise<ChatMessage[]>>().mockResolvedValue([]),
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
  fetchRecentDmMessages: vi.fn<() => Promise<DmMessage[]>>().mockResolvedValue([]),
  searchChannelMessages: vi
    .fn<(channelId: string) => Promise<ChatMessage[]>>()
    .mockResolvedValue([]),
  searchDmMessages: vi.fn<(threadId: string) => Promise<DmMessage[]>>().mockResolvedValue([]),
  canAccessDmThread: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  canAccessChannel: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  createMessageAttachment: vi.fn(),
  deleteMessageById: vi.fn(),
  reportMessageById: vi.fn(),
  muteUserInServer: vi.fn(),
  listModerationAuditLogs: vi.fn().mockResolvedValue([]),
  writeModerationAuditLog: vi.fn(),
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
