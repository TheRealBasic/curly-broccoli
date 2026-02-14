import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@curly-broccoli/shared';

beforeAll(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret';
});

const baseDeps = {
  fetchRecentMessages: vi.fn<() => Promise<ChatMessage[]>>().mockResolvedValue([]),
  findUserByUsername: vi.fn(),
  createUser: vi.fn(),
  storeRefreshToken: vi.fn().mockResolvedValue(undefined),
  findRefreshToken: vi.fn(),
  revokeRefreshToken: vi.fn().mockResolvedValue(undefined)
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

describe('GET /messages', () => {
  it('requires bearer token', async () => {
    const { createApp } = await import('../src/app.js');
    const app = createApp(baseDeps);

    const res = await request(app).get('/messages?limit=10');

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
      password_hash: 'x'
    });

    const app = createApp({
      ...baseDeps,
      findUserByUsername,
      createUser
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
});
