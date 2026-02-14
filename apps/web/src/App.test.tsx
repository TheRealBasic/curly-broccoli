import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.OPEN;
  private listeners = new Map<string, Array<(event?: MessageEvent) => void>>();

  constructor() {
    MockWebSocket.instances.push(this);
  }

  addEventListener = vi.fn((type: string, cb: (event?: MessageEvent) => void) => {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  });

  send = vi.fn();
  close = vi.fn();

  emit(type: string, payload?: unknown) {
    const list = this.listeners.get(type) ?? [];
    for (const listener of list) {
      if (type === 'message') {
        listener({ data: JSON.stringify(payload) } as MessageEvent);
      } else {
        listener();
      }
    }
  }
}

describe('App', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    localStorage.clear();
  });

  it('renders auth interface when signed out', () => {
    render(<App />);
    expect(screen.getByText('Create an account or sign in to enter chat.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('renders screen share viewer card for start/stop lifecycle events', async () => {
    localStorage.setItem(
      'curly_broccoli_auth',
      JSON.stringify({
        user: { id: 'user-1', username: 'alice' },
        accessToken: 'token-1',
        refreshToken: 'refresh-1',
      }),
    );

    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith('/servers')) {
        return new Response(
          JSON.stringify({
            servers: [{ id: 'server-1', name: 'Main', ownerId: 'user-1' }],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/servers/server-1/channels')) {
        return new Response(
          JSON.stringify({
            channels: [{ id: 'channel-1', serverId: 'server-1', name: 'general' }],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/servers/server-1/members')) {
        return new Response(
          JSON.stringify({
            members: [
              {
                userId: 'user-1',
                username: 'alice',
                role: 'owner',
                canShareScreen: true,
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/servers/server-1/audit-logs')) {
        return new Response(JSON.stringify({ logs: [] }), { status: 200 });
      }
      if (url.endsWith('/dm/threads')) {
        return new Response(JSON.stringify({ threads: [] }), { status: 200 });
      }

      return new Response(JSON.stringify({}), { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('#general')).toBeInTheDocument();
    });

    const socketInstance = MockWebSocket.instances[0];

    act(() => {
      socketInstance.emit('open');
      socketInstance.emit('message', {
        type: 'screen:share-start',
        payload: {
          channelId: 'channel-1',
          presenter: { userId: 'user-2', username: 'bob' },
        },
      });
    });

    expect(await screen.findByText('is sharing their screen')).toBeInTheDocument();

    act(() => {
      socketInstance.emit('message', {
        type: 'screen:share-stop',
        payload: { channelId: 'channel-1', presenterUserId: 'user-2' },
      });
    });

    await waitFor(() => {
      expect(screen.queryByText('is sharing their screen')).not.toBeInTheDocument();
    });
  });

  it('updates a channel message when chat:message-edited event arrives', async () => {
    localStorage.setItem(
      'curly_broccoli_auth',
      JSON.stringify({
        user: { id: 'user-1', username: 'alice' },
        accessToken: 'token-1',
        refreshToken: 'refresh-1',
      }),
    );

    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith('/servers')) {
        return new Response(
          JSON.stringify({ servers: [{ id: 'server-1', name: 'Main', ownerId: 'user-1' }] }),
          { status: 200 },
        );
      }
      if (url.includes('/servers/server-1/channels')) {
        return new Response(
          JSON.stringify({
            channels: [{ id: 'channel-1', serverId: 'server-1', name: 'general' }],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/servers/server-1/members')) {
        return new Response(
          JSON.stringify({
            members: [{ userId: 'user-1', username: 'alice', role: 'owner', canShareScreen: true }],
          }),
          { status: 200 },
        );
      }
      if (url.includes('/servers/server-1/audit-logs')) {
        return new Response(JSON.stringify({ logs: [] }), { status: 200 });
      }
      if (url.endsWith('/dm/threads')) {
        return new Response(JSON.stringify({ threads: [] }), { status: 200 });
      }

      return new Response(JSON.stringify({}), { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('#general')).toBeInTheDocument();
    });

    const socketInstance = MockWebSocket.instances[0];

    act(() => {
      socketInstance.emit('open');
      socketInstance.emit('message', {
        type: 'chat:history',
        payload: {
          channelId: 'channel-1',
          messages: [
            {
              id: 'msg-1',
              channelId: 'channel-1',
              userId: 'user-1',
              user: 'alice',
              text: 'hello',
              attachments: [],
              createdAt: '2024-01-01T00:00:00.000Z',
              editedAt: null,
            },
          ],
        },
      });
    });

    expect(await screen.findByText('hello')).toBeInTheDocument();

    act(() => {
      socketInstance.emit('message', {
        type: 'chat:message-edited',
        payload: {
          channelId: 'channel-1',
          messageId: 'msg-1',
          text: 'hello edited',
          editedAt: '2024-01-01T00:01:00.000Z',
        },
      });
    });

    expect(await screen.findByText('hello edited')).toBeInTheDocument();
    expect(screen.getByText('(edited)')).toBeInTheDocument();
  });
});
