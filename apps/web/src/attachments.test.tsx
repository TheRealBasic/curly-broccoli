import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

class MockXMLHttpRequest {
  static instances: MockXMLHttpRequest[] = [];
  upload = {
    addEventListener: vi.fn(
      (type: string, cb: (event: ProgressEvent<XMLHttpRequestEventTarget>) => void) => {
        if (type === 'progress') {
          this.progressListener = cb;
        }
      },
    ),
  };
  status = 0;
  responseText = '';
  private loadListener: (() => void) | null = null;
  private progressListener: ((event: ProgressEvent<XMLHttpRequestEventTarget>) => void) | null =
    null;

  constructor() {
    MockXMLHttpRequest.instances.push(this);
  }

  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn();

  addEventListener = vi.fn((type: string, cb: () => void) => {
    if (type === 'load') {
      this.loadListener = cb;
    }
  });

  emitProgress(loaded: number, total: number) {
    this.progressListener?.({
      lengthComputable: true,
      loaded,
      total,
    } as ProgressEvent<XMLHttpRequestEventTarget>);
  }

  emitLoad(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.loadListener?.();
  }
}

function buildSignedInFetchMock() {
  return vi.fn(async (input: URL | RequestInfo) => {
    const url = String(input);
    if (url.endsWith('/servers')) {
      return new Response(
        JSON.stringify({ servers: [{ id: 'server-1', name: 'Main', ownerId: 'user-1' }] }),
        { status: 200 },
      );
    }
    if (url.includes('/servers/server-1/channels')) {
      return new Response(
        JSON.stringify({ channels: [{ id: 'channel-1', serverId: 'server-1', name: 'general' }] }),
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
              isMuted: false,
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
}

describe('Attachment flows', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    MockWebSocket.instances = [];
    MockXMLHttpRequest.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal('XMLHttpRequest', MockXMLHttpRequest as unknown as typeof XMLHttpRequest);
    localStorage.setItem(
      'curly_broccoli_auth',
      JSON.stringify({
        user: { id: 'user-1', username: 'alice' },
        accessToken: 'token-1',
        refreshToken: 'refresh-1',
      }),
    );
  });

  it('renders non-image attachments in channel history', async () => {
    vi.stubGlobal('fetch', buildSignedInFetchMock());
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('#general')).toBeInTheDocument();
    });

    const socket = MockWebSocket.instances[0];
    act(() => {
      socket.emit('open');
      socket.emit('message', {
        type: 'chat:history',
        payload: {
          channelId: 'channel-1',
          messages: [
            {
              id: 'msg-1',
              channelId: 'channel-1',
              userId: 'user-1',
              user: 'alice',
              text: 'file attached',
              attachments: [
                {
                  id: 'att-1',
                  fileName: 'readme.txt',
                  mimeType: 'text/plain',
                  category: 'document',
                  sizeBytes: 5,
                  url: '/uploads/readme.txt',
                },
              ],
              createdAt: '2024-01-01T00:00:00.000Z',
              editedAt: null,
            },
          ],
        },
      });
    });

    expect(await screen.findByText(/readme.txt/)).toBeInTheDocument();
  });

  it('uploads attachment and sends attachment id in chat payload', async () => {
    vi.stubGlobal('fetch', buildSignedInFetchMock());
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('#general')).toBeInTheDocument();
    });

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, {
      target: { files: [new File(['hello'], 'hello.txt', { type: 'text/plain' })] },
    });

    const xhr = MockXMLHttpRequest.instances[0];
    act(() => {
      xhr.emitProgress(5, 10);
      xhr.emitLoad(201, { attachment: { id: 'att-1' } });
    });

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'sending message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(MockWebSocket.instances[0].send).toHaveBeenCalledWith(
      expect.stringContaining('"attachmentIds":["att-1"]'),
    );
  });
});
