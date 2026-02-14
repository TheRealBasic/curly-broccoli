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
            servers: [{ id: 'server-1', name: 'Main', ownerId: 'user-1', soundboardEnabled: true, voiceEffectsEnabled: true }],
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
      if (url.endsWith('/unread/summary')) {
        return new Response(
          JSON.stringify({
            summary: { channels: {}, dmThreads: {}, totalChannels: 0, totalDmThreads: 0 },
          }),
          { status: 200 },
        );
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


  it('hydrates co-watch state for late joiners', async () => {
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
        return new Response(JSON.stringify({ servers: [{ id: 'server-1', name: 'Main', ownerId: 'user-1', soundboardEnabled: true, voiceEffectsEnabled: true }] }), { status: 200 });
      }
      if (url.includes('/servers/server-1/channels')) {
        return new Response(JSON.stringify({ channels: [{ id: 'channel-1', serverId: 'server-1', name: 'general' }] }), { status: 200 });
      }
      if (url.includes('/servers/server-1/members')) {
        return new Response(JSON.stringify({ members: [{ userId: 'user-1', username: 'alice', role: 'owner', canShareScreen: true, isMuted: false }] }), { status: 200 });
      }
      if (url.includes('/servers/server-1/audit-logs')) {
        return new Response(JSON.stringify({ logs: [] }), { status: 200 });
      }
      if (url.endsWith('/dm/threads')) {
        return new Response(JSON.stringify({ threads: [] }), { status: 200 });
      }
      if (url.endsWith('/unread/summary')) {
        return new Response(JSON.stringify({ summary: { channels: {}, dmThreads: {}, totalChannels: 0, totalDmThreads: 0 } }), { status: 200 });
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
        type: 'watch:state',
        payload: {
          channelId: 'channel-1',
          state: {
            hostUserId: 'user-1',
            controllers: [],
            media: { sourceType: 'url', url: 'https://example.com/video.mp4', title: 'Demo' },
            paused: true,
            positionSec: 4,
            lastEventAt: new Date().toISOString(),
          },
        },
      });
    });

    expect(await screen.findByRole('button', { name: 'Play' })).toBeInTheDocument();
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
          JSON.stringify({ servers: [{ id: 'server-1', name: 'Main', ownerId: 'user-1', soundboardEnabled: true, voiceEffectsEnabled: true }] }),
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
            members: [{ userId: 'user-1', username: 'alice', role: 'owner', canShareScreen: true, isMuted: false }],
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
      if (url.endsWith('/unread/summary')) {
        return new Response(
          JSON.stringify({
            summary: { channels: {}, dmThreads: {}, totalChannels: 0, totalDmThreads: 0 },
          }),
          { status: 200 },
        );
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

  it('shows unmute and permission toggle for owners and sends moderation requests', async () => {
    localStorage.setItem(
      'curly_broccoli_auth',
      JSON.stringify({
        user: { id: 'owner-1', username: 'alice' },
        accessToken: 'token-1',
        refreshToken: 'refresh-1',
      }),
    );

    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/servers')) {
        return new Response(
          JSON.stringify({ servers: [{ id: 'server-1', name: 'Main', ownerId: 'owner-1', soundboardEnabled: true, voiceEffectsEnabled: true }] }),
          { status: 200 },
        );
      }
      if (url.includes('/servers/server-1/channels')) {
        return new Response(
          JSON.stringify({ channels: [{ id: 'channel-1', serverId: 'server-1', name: 'general' }] }),
          { status: 200 },
        );
      }
      if (url.includes('/servers/server-1/members') && !url.includes('/permissions')) {
        return new Response(
          JSON.stringify({
            members: [
              {
                userId: 'owner-1',
                username: 'alice',
                role: 'owner',
                canShareScreen: true,
                isMuted: false,
              },
              {
                userId: 'member-1',
                username: 'bob',
                role: 'member',
                canShareScreen: false,
                isMuted: true,
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
      if (url.endsWith('/unread/summary')) {
        return new Response(
          JSON.stringify({
            summary: { channels: {}, dmThreads: {}, totalChannels: 0, totalDmThreads: 0 },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/servers/server-1/mutes/member-1') && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/servers/server-1/members/member-1/permissions') && init?.method === 'PATCH') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      return new Response(JSON.stringify({}), { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('#general')).toBeInTheDocument();
    });

    const unmuteButton = await screen.findByRole('button', { name: 'Unmute' });
    await act(async () => {
      unmuteButton.click();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/servers/server-1/mutes/member-1'),
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    const permissionCheckboxes = screen.getAllByRole('checkbox');
    const memberPermission = permissionCheckboxes.find((checkbox) => !(checkbox as HTMLInputElement).checked);
    expect(memberPermission).toBeTruthy();

    await act(async () => {
      (memberPermission as HTMLInputElement).click();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/servers/server-1/members/member-1/permissions'),
        expect.objectContaining({ method: 'PATCH' }),
      );
    });
  });

  it('toggles spatial audio setting and persists it', async () => {
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
        return new Response(JSON.stringify({ servers: [{ id: 'server-1', name: 'Main', ownerId: 'user-1', soundboardEnabled: true, voiceEffectsEnabled: true }] }), { status: 200 });
      }
      if (url.includes('/servers/server-1/channels')) {
        return new Response(JSON.stringify({ channels: [{ id: 'channel-1', serverId: 'server-1', name: 'general' }] }), { status: 200 });
      }
      if (url.includes('/servers/server-1/members')) {
        return new Response(JSON.stringify({ members: [{ userId: 'user-1', username: 'alice', role: 'owner', canShareScreen: true, isMuted: false }] }), { status: 200 });
      }
      if (url.includes('/servers/server-1/audit-logs')) {
        return new Response(JSON.stringify({ logs: [] }), { status: 200 });
      }
      if (url.endsWith('/dm/threads')) {
        return new Response(JSON.stringify({ threads: [] }), { status: 200 });
      }
      if (url.endsWith('/unread/summary')) {
        return new Response(JSON.stringify({ summary: { channels: {}, dmThreads: {}, totalChannels: 0, totalDmThreads: 0 } }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText('#general')).toBeInTheDocument();
    });

    const checkbox = screen.getByRole('checkbox', { name: 'Enable spatial audio' }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    await act(async () => {
      checkbox.click();
    });

    expect(checkbox.checked).toBe(true);
    expect(localStorage.getItem('curly_broccoli_spatial_audio_enabled')).toBe('true');
  });

  it('creates and disposes spatial audio nodes as participants join and leave', async () => {
    localStorage.setItem(
      'curly_broccoli_auth',
      JSON.stringify({
        user: { id: 'user-1', username: 'alice' },
        accessToken: 'token-1',
        refreshToken: 'refresh-1',
      }),
    );
    localStorage.setItem('curly_broccoli_spatial_audio_enabled', 'true');

    class MockMediaStream {}
    vi.stubGlobal('MediaStream', MockMediaStream as unknown as typeof MediaStream);
    vi.stubGlobal('navigator', {
      ...navigator,
      mediaDevices: {
        getUserMedia: vi.fn(async () => ({ getTracks: () => [] })),
      },
    });

    const connectSpy = vi.fn();
    const disconnectSpy = vi.fn();
    const audioContextMock = {
      currentTime: 0,
      destination: {},
      createMediaStreamSource: vi.fn(() => ({ connect: connectSpy, disconnect: disconnectSpy })),
      createPanner: vi.fn(() => ({
        panningModel: 'HRTF',
        distanceModel: 'inverse',
        refDistance: 1,
        maxDistance: 15,
        rolloffFactor: 1,
        positionX: { value: 0, setTargetAtTime: vi.fn() },
        positionY: { value: 0, setTargetAtTime: vi.fn() },
        positionZ: { value: 0, setTargetAtTime: vi.fn() },
        setPosition: vi.fn(),
        connect: connectSpy,
        disconnect: disconnectSpy,
      })),
      createGain: vi.fn(() => ({ gain: { value: 1 }, connect: connectSpy, disconnect: disconnectSpy })),
      createAnalyser: vi.fn(() => ({ fftSize: 0, connect: connectSpy, disconnect: disconnectSpy, getByteTimeDomainData: vi.fn() })),
      close: vi.fn(),
    };
    vi.stubGlobal('AudioContext', vi.fn(() => audioContextMock));

    class MockRTCPeerConnection {
      static instances: MockRTCPeerConnection[] = [];
      ontrack: ((event: RTCTrackEvent) => void) | null = null;
      onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
      onconnectionstatechange: (() => void) | null = null;
      connectionState: RTCPeerConnectionState = 'connected';
      constructor() {
        MockRTCPeerConnection.instances.push(this);
      }
      addTrack() { return {} as RTCRtpSender; }
      createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'x' }));
      setLocalDescription = vi.fn(async () => {});
      close = vi.fn();
      restartIce = vi.fn();
      setRemoteDescription = vi.fn(async () => {});
      createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'y' }));
      addIceCandidate = vi.fn(async () => {});
    }
    vi.stubGlobal('RTCPeerConnection', MockRTCPeerConnection as unknown as typeof RTCPeerConnection);
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);

    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.endsWith('/servers')) return new Response(JSON.stringify({ servers: [{ id: 'server-1', name: 'Main', ownerId: 'user-1', soundboardEnabled: true, voiceEffectsEnabled: true }] }), { status: 200 });
      if (url.includes('/servers/server-1/channels')) return new Response(JSON.stringify({ channels: [{ id: 'channel-1', serverId: 'server-1', name: 'general' }] }), { status: 200 });
      if (url.includes('/servers/server-1/members')) return new Response(JSON.stringify({ members: [{ userId: 'user-1', username: 'alice', role: 'owner', canShareScreen: true, isMuted: false }] }), { status: 200 });
      if (url.includes('/servers/server-1/audit-logs')) return new Response(JSON.stringify({ logs: [] }), { status: 200 });
      if (url.endsWith('/dm/threads')) return new Response(JSON.stringify({ threads: [] }), { status: 200 });
      if (url.endsWith('/unread/summary')) return new Response(JSON.stringify({ summary: { channels: {}, dmThreads: {}, totalChannels: 0, totalDmThreads: 0 } }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await waitFor(() => expect(screen.getByText('#general')).toBeInTheDocument());

    const socketInstance = MockWebSocket.instances[0];
    act(() => {
      socketInstance.emit('open');
      socketInstance.emit('message', {
        type: 'voice:participants',
        payload: {
          channelId: 'channel-1',
          participants: [
            { userId: 'user-1', username: 'alice' },
            { userId: 'user-2', username: 'bob' },
          ],
        },
      });
    });

    const remoteStream = new MockMediaStream() as unknown as MediaStream;
    act(() => {
      const pc = MockRTCPeerConnection.instances[0];
      pc.ontrack?.({ streams: [remoteStream] } as RTCTrackEvent);
      socketInstance.emit('message', {
        type: 'voice:user-left',
        payload: { channelId: 'channel-1', userId: 'user-2' },
      });
    });

    await waitFor(() => {
      expect(audioContextMock.createPanner).toHaveBeenCalled();
      expect(disconnectSpy).toHaveBeenCalled();
    });
  });


  it('shows AI settings panel with owner-only permissions for non-owners', async () => {
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
        return new Response(JSON.stringify({ servers: [{ id: 'server-1', name: 'Main', ownerId: 'owner-9', soundboardEnabled: true, voiceEffectsEnabled: true }] }), { status: 200 });
      }
      if (url.includes('/servers/server-1/channels')) {
        return new Response(JSON.stringify({ channels: [{ id: 'channel-1', serverId: 'server-1', name: 'general' }] }), { status: 200 });
      }
      if (url.includes('/servers/server-1/members')) {
        return new Response(JSON.stringify({ members: [{ userId: 'owner-9', username: 'owner', role: 'owner', canShareScreen: true, isMuted: false }, { userId: 'user-1', username: 'alice', role: 'member', canShareScreen: true, isMuted: false }] }), { status: 200 });
      }
      if (url.includes('/servers/server-1/ai-settings')) {
        return new Response(JSON.stringify({ settings: { serverId: 'server-1', enabled: true, botDisplayName: 'assistant', model: 'gpt-4.1-mini', systemPrompt: null, maxTokensPerReply: 256, temperature: 0.7, invocationPolicy: 'everyone', status: { enabled: true, keyMissing: false, budgetReached: false, degradedMode: true } } }), { status: 200 });
      }
      if (url.includes('/servers/server-1/audit-logs')) {
        return new Response(JSON.stringify({ logs: [] }), { status: 200 });
      }
      if (url.endsWith('/dm/threads')) {
        return new Response(JSON.stringify({ threads: [] }), { status: 200 });
      }
      if (url.endsWith('/unread/summary')) {
        return new Response(JSON.stringify({ summary: { channels: {}, dmThreads: {}, totalChannels: 0, totalDmThreads: 0 } }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    expect(await screen.findByText('AI Settings')).toBeInTheDocument();
    expect(await screen.findByText('Owner-only settings')).toBeInTheDocument();
    expect(screen.getByLabelText('Enable assistant')).toBeDisabled();
  });

  it('renders streaming AI reply lifecycle from start to completion', async () => {
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
        return new Response(JSON.stringify({ servers: [{ id: 'server-1', name: 'Main', ownerId: 'user-1', soundboardEnabled: true, voiceEffectsEnabled: true }] }), { status: 200 });
      }
      if (url.includes('/servers/server-1/channels')) {
        return new Response(JSON.stringify({ channels: [{ id: 'channel-1', serverId: 'server-1', name: 'general' }] }), { status: 200 });
      }
      if (url.includes('/servers/server-1/members')) {
        return new Response(JSON.stringify({ members: [{ userId: 'user-1', username: 'alice', role: 'owner', canShareScreen: true, isMuted: false }] }), { status: 200 });
      }
      if (url.includes('/servers/server-1/ai-settings')) {
        return new Response(JSON.stringify({ settings: { serverId: 'server-1', enabled: true, botDisplayName: 'assistant', model: 'gpt-4.1-mini', systemPrompt: null, maxTokensPerReply: 256, temperature: 0.7, invocationPolicy: 'everyone', status: { enabled: true, keyMissing: false, budgetReached: false, degradedMode: true } } }), { status: 200 });
      }
      if (url.includes('/servers/server-1/audit-logs')) {
        return new Response(JSON.stringify({ logs: [] }), { status: 200 });
      }
      if (url.endsWith('/dm/threads')) {
        return new Response(JSON.stringify({ threads: [] }), { status: 200 });
      }
      if (url.endsWith('/unread/summary')) {
        return new Response(JSON.stringify({ summary: { channels: {}, dmThreads: {}, totalChannels: 0, totalDmThreads: 0 } }), { status: 200 });
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
        type: 'ai:reply-start',
        payload: {
          channelId: 'channel-1',
          requestId: 'req-1',
          requestedByUserId: 'user-1',
          botDisplayName: 'assistant',
        },
      });
      socketInstance.emit('message', {
        type: 'ai:reply-chunk',
        payload: {
          channelId: 'channel-1',
          requestId: 'req-1',
          chunk: 'Hello',
        },
      });
    });

    expect(await screen.findByText('assistant')).toBeInTheDocument();
    expect(await screen.findByText('Hello')).toBeInTheDocument();

    act(() => {
      socketInstance.emit('message', {
        type: 'ai:reply-complete',
        payload: {
          channelId: 'channel-1',
          requestId: 'req-1',
          message: {
            id: 'bot-1',
            channelId: 'channel-1',
            userId: null,
            user: 'assistant',
            text: 'Hello',
            attachments: [],
            createdAt: '2024-01-01T00:00:00.000Z',
            editedAt: null,
          },
        },
      });
    });

    await waitFor(() => {
      expect(screen.queryByText('assistant')).not.toBeInTheDocument();
    });
  });

});
