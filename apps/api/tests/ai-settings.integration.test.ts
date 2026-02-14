import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createAccessToken } from '../src/auth.js';
import { createApp } from '../src/app.js';
import type { ChannelSummary, ChatMessage, DmMessage, DmThreadSummary, ServerSummary } from '@curly-broccoli/shared';

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
  createMessageAttachment: vi.fn(),
  markChannelAsRead: vi.fn().mockResolvedValue(undefined),
  markDmThreadAsRead: vi.fn().mockResolvedValue(undefined),
  getUnreadSummary: vi.fn().mockResolvedValue({ channels: {}, dmThreads: {}, totalChannels: 0, totalDmThreads: 0 }),
  notifyUnreadUpdated: vi.fn(),
  deleteMessageById: vi.fn(),
  updateMessageById: vi.fn(),
  reportMessageById: vi.fn(),
  muteUserInServer: vi.fn(),
  unmuteUserInServer: vi.fn(),
  updateMemberScreenSharePermission: vi.fn(),
  updateServerAudioSettings: vi.fn(),
  getServerAiSettings: vi.fn(),
  updateServerAiSettings: vi.fn(),
  listModerationAuditLogs: vi.fn().mockResolvedValue([]),
  writeModerationAuditLog: vi.fn(),
  notifyMessageEdited: vi.fn(),
};

describe('AI settings integration', () => {
  it('enforces owner-only settings updates', async () => {
    const app = createApp({
      ...baseDeps,
      updateServerAiSettings: vi.fn().mockRejectedValue(new Error('forbidden')),
    });

    const token = createAccessToken({ id: 'user-2', username: 'member' });
    const res = await request(app)
      .patch('/servers/server-1/ai-settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ enabled: true });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Only server owners');
  });

  it('enforces rate-limit and budget payload constraints', async () => {
    const app = createApp(baseDeps);
    const token = createAccessToken({ id: 'owner-1', username: 'owner' });

    const rateLimitRes = await request(app)
      .patch('/servers/server-1/ai-settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ rateLimitUserRequests: 0 });

    expect(rateLimitRes.status).toBe(400);
    expect(rateLimitRes.body.error).toContain('rateLimitUserRequests');

    const budgetRes = await request(app)
      .patch('/servers/server-1/ai-settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ dailyTokenBudget: -1 });

    expect(budgetRes.status).toBe(400);
    expect(budgetRes.body.error).toContain('dailyTokenBudget');
  });
});
