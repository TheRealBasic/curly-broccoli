import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@curly-broccoli/shared';
import { createApp } from '../src/app.js';

describe('GET /health', () => {
  it('returns ok payload', async () => {
    const app = createApp({
      fetchRecentMessages: vi.fn<() => Promise<ChatMessage[]>>().mockResolvedValue([])
    });
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: 'api' });
  });
});

describe('GET /messages', () => {
  it('returns recent messages payload', async () => {
    const fetchRecentMessages = vi.fn<() => Promise<ChatMessage[]>>().mockResolvedValue([
      {
        id: 'msg-1',
        user: 'SwiftOtter111',
        text: 'hello world',
        createdAt: '2026-01-01T00:00:00.000Z'
      }
    ]);
    const app = createApp({ fetchRecentMessages });

    const res = await request(app).get('/messages?limit=10');

    expect(fetchRecentMessages).toHaveBeenCalledWith(10);
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(1);
  });
});
