import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  APP_NAME,
  type ChannelSummary,
  type ChatMessage,
  type DmMessage,
  type DmThreadSummary,
  type ServerEvent,
  type ServerMember,
  type ServerSummary,
} from '@curly-broccoli/shared';

type ConnectionState = 'connecting' | 'open' | 'closed';

type AuthState = {
  user: { id: string; username: string };
  accessToken: string;
  refreshToken: string;
};

type AuthMode = 'login' | 'register';

const AUTH_STORAGE_KEY = 'curly_broccoli_auth';
const TYPING_STOP_DELAY_MS = 1200;

function loadAuthState() {
  const raw = localStorage.getItem(AUTH_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as AuthState;
  } catch {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return null;
  }
}

function saveAuthState(value: AuthState | null) {
  if (!value) {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    return;
  }

  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(value));
}

export function App() {
  const apiBase = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';
  const socketRef = useRef<WebSocket | null>(null);
  const typingTimeoutRef = useRef<number | null>(null);
  const isTypingRef = useRef(false);
  const activeChannelRef = useRef<string | null>(null);
  const activeDmThreadRef = useRef<string | null>(null);

  const [auth, setAuth] = useState<AuthState | null>(() => loadAuthState());
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [usernameInput, setUsernameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [connectionState, setConnectionState] = useState<ConnectionState>('closed');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [systemMessage, setSystemMessage] = useState('Sign in to join chat.');
  const [error, setError] = useState<string | null>(null);

  const [servers, setServers] = useState<ServerSummary[]>([]);
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [members, setMembers] = useState<ServerMember[]>([]);
  const [onlineUserIdsByServer, setOnlineUserIdsByServer] = useState<Record<string, string[]>>({});
  const [typingByChannel, setTypingByChannel] = useState<
    Record<string, { userId: string; username: string }[]>
  >({});
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [serverNameInput, setServerNameInput] = useState('');
  const [channelNameInput, setChannelNameInput] = useState('');
  const [inviteUsernameInput, setInviteUsernameInput] = useState('');
  const [dmThreads, setDmThreads] = useState<DmThreadSummary[]>([]);
  const [activeDmThreadId, setActiveDmThreadId] = useState<string | null>(null);
  const [dmMessages, setDmMessages] = useState<DmMessage[]>([]);
  const [dmUsernameInput, setDmUsernameInput] = useState('');
  const [chatMode, setChatMode] = useState<'channel' | 'dm'>('channel');

  const wsUrl = useMemo(() => {
    if (!auth?.accessToken) {
      return null;
    }

    const base = apiBase.replace(/^http/, 'ws');
    return `${base}/?token=${encodeURIComponent(auth.accessToken)}`;
  }, [apiBase, auth?.accessToken]);

  const typingUsers = activeChannelId ? (typingByChannel[activeChannelId] ?? []) : [];
  const visibleMessages = chatMode === 'dm' ? dmMessages : messages;

  useEffect(() => {
    activeChannelRef.current = activeChannelId;
  }, [activeChannelId]);

  useEffect(() => {
    activeDmThreadRef.current = activeDmThreadId;
  }, [activeDmThreadId]);

  function updateAuth(next: AuthState | null) {
    setAuth(next);
    saveAuthState(next);
  }

  function sendTypingStop(channelId?: string) {
    const socket = socketRef.current;
    const targetChannelId = channelId ?? activeChannelId;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      !targetChannelId ||
      !isTypingRef.current
    ) {
      return;
    }

    socket.send(JSON.stringify({ type: 'typing:stop', payload: { channelId: targetChannelId } }));
    isTypingRef.current = false;

    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }
  }

  function queueTypingStop() {
    if (typingTimeoutRef.current) {
      window.clearTimeout(typingTimeoutRef.current);
    }

    typingTimeoutRef.current = window.setTimeout(() => {
      sendTypingStop();
    }, TYPING_STOP_DELAY_MS);
  }

  async function authedFetch(path: string, init?: RequestInit) {
    if (!auth) {
      throw new Error('Not authenticated.');
    }

    const headers = new Headers(init?.headers ?? {});
    headers.set('Authorization', `Bearer ${auth.accessToken}`);
    return fetch(`${apiBase}${path}`, { ...init, headers });
  }

  async function loadServers() {
    const res = await authedFetch('/servers');
    if (!res.ok) {
      throw new Error('Unable to load servers.');
    }

    const data = (await res.json()) as { servers: ServerSummary[] };
    setServers(data.servers);
    if (!activeServerId && data.servers.length > 0) {
      setActiveServerId(data.servers[0].id);
    }
  }

  async function loadChannels(serverId: string) {
    const res = await authedFetch(`/servers/${serverId}/channels`);
    if (!res.ok) {
      throw new Error('Unable to load channels.');
    }

    const data = (await res.json()) as { channels: ChannelSummary[] };
    setChannels(data.channels);
    if (!data.channels.some((channel) => channel.id === activeChannelId)) {
      setActiveChannelId(data.channels[0]?.id ?? null);
    }
  }

  async function loadMembers(serverId: string) {
    const res = await authedFetch(`/servers/${serverId}/members`);
    if (!res.ok) {
      throw new Error('Unable to load members.');
    }

    const data = (await res.json()) as { members: ServerMember[] };
    setMembers(data.members);
  }


  async function loadDmThreads() {
    const res = await authedFetch('/dm/threads');
    if (!res.ok) {
      throw new Error('Unable to load DM threads.');
    }

    const data = (await res.json()) as { threads: DmThreadSummary[] };
    setDmThreads(data.threads);
    if (!activeDmThreadId && data.threads.length > 0) {
      setActiveDmThreadId(data.threads[0].id);
    }
  }

  useEffect(() => {
    if (!auth) {
      setConnectionState('closed');
      setMessages([]);
      setServers([]);
      setChannels([]);
      setMembers([]);
      setOnlineUserIdsByServer({});
      setTypingByChannel({});
      setActiveServerId(null);
      setActiveChannelId(null);
      setSystemMessage('Sign in to join chat.');
      setDmThreads([]);
      setActiveDmThreadId(null);
      setDmMessages([]);
      setChatMode('channel');
      return;
    }

    void Promise.all([loadServers(), loadDmThreads()]).catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Unable to load servers.');
    });
  }, [auth]);

  useEffect(() => {
    if (!auth || !activeServerId) {
      setChannels([]);
      setMembers([]);
      setActiveChannelId(null);
      return;
    }

    void Promise.all([loadChannels(activeServerId), loadMembers(activeServerId)]).catch(
      (reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Unable to load server data.');
      },
    );
  }, [auth?.user.id, activeServerId]);

  useEffect(() => {
    if (!wsUrl || !auth) {
      return;
    }

    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;
    setConnectionState('connecting');

    socket.addEventListener('open', () => {
      setConnectionState('open');
      setError(null);
      if (activeServerId) {
        socket.send(
          JSON.stringify({ type: 'presence:join-server', payload: { serverId: activeServerId } }),
        );
      }
    });

    socket.addEventListener('message', (event) => {
      let parsed: ServerEvent;

      try {
        parsed = JSON.parse(String(event.data)) as ServerEvent;
      } catch {
        setError('Received an invalid event from server.');
        return;
      }

      if (parsed.type === 'chat:history') {
        if (parsed.payload.channelId === activeChannelRef.current) {
          setMessages(parsed.payload.messages);
        }
      }

      if (parsed.type === 'chat:message') {
        if (parsed.payload.message.channelId === activeChannelRef.current) {
          setMessages((prev) => [...prev, parsed.payload.message]);
        }
      }

      if (parsed.type === 'dm:history') {
        if (parsed.payload.threadId === activeDmThreadRef.current) {
          setDmMessages(parsed.payload.messages);
        }
      }

      if (parsed.type === 'dm:message') {
        setDmThreads((prev) => {
          const hasThread = prev.some((thread) => thread.id === parsed.payload.message.threadId);
          if (!hasThread) {
            return prev;
          }

          const next = prev.map((thread) =>
            thread.id === parsed.payload.message.threadId
              ? { ...thread, lastMessageAt: parsed.payload.message.createdAt }
              : thread,
          );
          next.sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''));
          return next;
        });

        if (parsed.payload.message.threadId === activeDmThreadRef.current) {
          setDmMessages((prev) => [...prev, parsed.payload.message]);
        }
      }

      if (parsed.type === 'presence:sync') {
        setOnlineUserIdsByServer((prev) => ({
          ...prev,
          [parsed.payload.serverId]: parsed.payload.onlineUserIds,
        }));
      }

      if (parsed.type === 'presence:user-online') {
        setOnlineUserIdsByServer((prev) => {
          const existing = new Set(prev[parsed.payload.serverId] ?? []);
          existing.add(parsed.payload.userId);
          return { ...prev, [parsed.payload.serverId]: Array.from(existing) };
        });
      }

      if (parsed.type === 'presence:user-offline') {
        setOnlineUserIdsByServer((prev) => ({
          ...prev,
          [parsed.payload.serverId]: (prev[parsed.payload.serverId] ?? []).filter(
            (userId) => userId !== parsed.payload.userId,
          ),
        }));
      }

      if (parsed.type === 'typing:start') {
        if (parsed.payload.userId === auth.user.id) {
          return;
        }

        setTypingByChannel((prev) => {
          const current = prev[parsed.payload.channelId] ?? [];
          if (current.some((item) => item.userId === parsed.payload.userId)) {
            return prev;
          }

          return {
            ...prev,
            [parsed.payload.channelId]: [
              ...current,
              { userId: parsed.payload.userId, username: parsed.payload.username },
            ],
          };
        });
      }

      if (parsed.type === 'typing:stop') {
        setTypingByChannel((prev) => ({
          ...prev,
          [parsed.payload.channelId]: (prev[parsed.payload.channelId] ?? []).filter(
            (item) => item.userId !== parsed.payload.userId,
          ),
        }));
      }

      if (parsed.type === 'system') {
        setSystemMessage(parsed.payload.text);
      }

      if (parsed.type === 'error') {
        setError(parsed.payload.message);
      }
    });

    socket.addEventListener('close', () => {
      setConnectionState('closed');
      setError('Disconnected from chat server.');
    });

    return () => {
      sendTypingStop();
      socket.close();
      socketRef.current = null;
    };
  }, [wsUrl, auth?.user.id]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !activeChannelId) {
      return;
    }

    setMessages([]);
    socket.send(
      JSON.stringify({
        type: 'chat:join-channel',
        payload: { channelId: activeChannelId },
      }),
    );
  }, [activeChannelId, connectionState]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !activeServerId) {
      return;
    }

    socket.send(
      JSON.stringify({ type: 'presence:join-server', payload: { serverId: activeServerId } }),
    );
  }, [activeServerId, connectionState]);


  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !activeDmThreadId) {
      return;
    }

    setDmMessages([]);
    socket.send(
      JSON.stringify({
        type: 'dm:join-thread',
        payload: { threadId: activeDmThreadId },
      }),
    );
  }, [activeDmThreadId, connectionState]);

  function sendMessage() {
    const socket = socketRef.current;
    const text = draft.trim();
    if (!socket || socket.readyState !== WebSocket.OPEN || !text) {
      return;
    }

    if (chatMode === 'dm') {
      if (!activeDmThreadId) {
        return;
      }

      socket.send(
        JSON.stringify({
          type: 'dm:send',
          payload: { text },
        }),
      );
      setDraft('');
      setError(null);
      return;
    }

    if (!activeChannelId) {
      return;
    }

    sendTypingStop(activeChannelId);
    socket.send(
      JSON.stringify({
        type: 'chat:send',
        payload: { text },
      }),
    );
    setDraft('');
    setError(null);
  }

  async function submitAuthForm(event: FormEvent) {
    event.preventDefault();

    const endpoint = authMode === 'login' ? '/auth/login' : '/auth/register';
    const res = await fetch(`${apiBase}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: usernameInput, password: passwordInput }),
    });

    const data = (await res.json()) as
      | {
          user: { id: string; username: string };
          tokens: { accessToken: string; refreshToken: string };
        }
      | { error: string };

    if (!res.ok || 'error' in data) {
      setError('error' in data ? data.error : 'Unable to authenticate.');
      return;
    }

    updateAuth({
      user: data.user,
      accessToken: data.tokens.accessToken,
      refreshToken: data.tokens.refreshToken,
    });

    setUsernameInput('');
    setPasswordInput('');
    setError(null);
  }

  async function createServer(event: FormEvent) {
    event.preventDefault();
    const name = serverNameInput.trim();
    if (!name) {
      return;
    }

    const res = await authedFetch('/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });

    if (!res.ok) {
      setError('Unable to create server.');
      return;
    }

    setServerNameInput('');
    await loadServers();
  }

  async function createChannel(event: FormEvent) {
    event.preventDefault();
    const name = channelNameInput.trim();
    if (!name || !activeServerId) {
      return;
    }

    const res = await authedFetch(`/servers/${activeServerId}/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });

    if (!res.ok) {
      setError('Unable to create channel.');
      return;
    }

    setChannelNameInput('');
    await loadChannels(activeServerId);
  }

  async function addMember(event: FormEvent) {
    event.preventDefault();
    const username = inviteUsernameInput.trim().toLowerCase();
    if (!username || !activeServerId) {
      return;
    }

    const res = await authedFetch(`/servers/${activeServerId}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });

    if (!res.ok) {
      setError('Unable to add member (owner-only action).');
      return;
    }

    setInviteUsernameInput('');
    await loadMembers(activeServerId);
    setError(null);
  }

  async function startDm(event: FormEvent) {
    event.preventDefault();
    const username = dmUsernameInput.trim().toLowerCase();
    if (!username) {
      return;
    }

    const res = await authedFetch('/dm/threads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });

    if (!res.ok) {
      setError('Unable to start DM.');
      return;
    }

    const data = (await res.json()) as { threadId: string };
    setDmUsernameInput('');
    setChatMode('dm');
    setActiveDmThreadId(data.threadId);
    await loadDmThreads();
    setError(null);
  }

  async function logout() {

    if (auth?.refreshToken) {
      await fetch(`${apiBase}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: auth.refreshToken }),
      });
    }

    sendTypingStop();
    socketRef.current?.close();
    updateAuth(null);
  }

  if (!auth) {
    return (
      <main className="chat-layout auth-layout">
        <h1>{APP_NAME}</h1>
        <p className="subtle">Create an account or sign in to enter chat.</p>

        <div className="auth-toggle" role="tablist" aria-label="Authentication mode">
          <button
            type="button"
            className={authMode === 'login' ? 'active' : ''}
            onClick={() => setAuthMode('login')}
          >
            Login
          </button>
          <button
            type="button"
            className={authMode === 'register' ? 'active' : ''}
            onClick={() => setAuthMode('register')}
          >
            Register
          </button>
        </div>

        <form className="auth-form" onSubmit={submitAuthForm}>
          <label>
            Username
            <input
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
              minLength={3}
              maxLength={32}
              required
            />
          </label>
          <label>
            Password
            <input
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              type="password"
              minLength={8}
              maxLength={128}
              required
            />
          </label>
          <button type="submit">{authMode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>

        {error && <p className="error">{error}</p>}
      </main>
    );
  }

  return (
    <main className="chat-layout guild-layout">
      <header className="chat-header">
        <div>
          <h1>{APP_NAME}</h1>
          <p className="subtle">
            Signed in as <strong>{auth.user.username}</strong>
          </p>
          <p className="subtle">
            Status: <strong>{connectionState}</strong> · {systemMessage}
          </p>
        </div>
        <button type="button" className="logout-button" onClick={logout}>
          Logout
        </button>
      </header>

      <section className="guild-shell">
        <aside className="sidebar">
          <h3>Servers</h3>
          <div className="list">
            {servers.map((server) => (
              <button
                key={server.id}
                type="button"
                className={server.id === activeServerId ? 'list-item active' : 'list-item'}
                onClick={() => setActiveServerId(server.id)}
              >
                {server.name}
              </button>
            ))}
          </div>
          <form className="inline-form" onSubmit={createServer}>
            <input
              value={serverNameInput}
              onChange={(event) => setServerNameInput(event.target.value)}
              placeholder="New server"
            />
            <button type="submit">Create</button>
          </form>
        </aside>

        <aside className="sidebar">
          <h3>Channels</h3>
          <div className="list">
            {channels.map((channel) => (
              <button
                key={channel.id}
                type="button"
                className={channel.id === activeChannelId ? 'list-item active' : 'list-item'}
                onClick={() => setActiveChannelId(channel.id)}
              >
                #{channel.name}
              </button>
            ))}
          </div>
          <form className="inline-form" onSubmit={createChannel}>
            <input
              value={channelNameInput}
              onChange={(event) => setChannelNameInput(event.target.value)}
              placeholder="New channel"
            />
            <button type="submit" disabled={!activeServerId}>
              Add
            </button>
          </form>
          <form className="inline-form" onSubmit={addMember}>
            <input
              value={inviteUsernameInput}
              onChange={(event) => setInviteUsernameInput(event.target.value)}
              placeholder="Invite username"
            />
            <button type="submit" disabled={!activeServerId}>
              Invite
            </button>
          </form>
        </aside>

        <aside className="sidebar">
          <h3>Direct Messages</h3>
          <div className="list">
            {dmThreads.map((thread) => (
              <button
                key={thread.id}
                type="button"
                className={thread.id === activeDmThreadId && chatMode === 'dm' ? 'list-item active' : 'list-item'}
                onClick={() => {
                  setChatMode('dm');
                  setActiveDmThreadId(thread.id);
                }}
              >
                @{thread.otherUsername}
              </button>
            ))}
          </div>
          <form className="inline-form" onSubmit={startDm}>
            <input
              value={dmUsernameInput}
              onChange={(event) => setDmUsernameInput(event.target.value)}
              placeholder="Start DM (username)"
            />
            <button type="submit">Start</button>
          </form>
          <button type="button" className="list-item" onClick={() => setChatMode('channel')}>
            Back to channels
          </button>
        </aside>

        <section className="chat-panel">
          <section className="chat-box" aria-label="Messages">
            {chatMode === 'channel' && !activeChannelId && <p className="empty">Pick a channel to start chatting.</p>}
            {chatMode === 'dm' && !activeDmThreadId && <p className="empty">Select a DM thread.</p>}
            {((chatMode === 'channel' && activeChannelId) || (chatMode === 'dm' && activeDmThreadId)) && visibleMessages.length === 0 && <p className="empty">No messages yet.</p>}
            {visibleMessages.map((message) => (
              <article key={message.id} className="message">
                <header>
                  <strong>{'user' in message ? message.user : message.senderUsername}</strong>
                  <time>{new Date(message.createdAt).toLocaleTimeString()}</time>
                </header>
                <p>{message.text}</p>
              </article>
            ))}
          </section>

          {chatMode === 'channel' && <p className="typing-indicator" aria-live="polite">
            {typingUsers.length === 1 && `${typingUsers[0].username} is typing...`}
            {typingUsers.length > 1 &&
              `${typingUsers
                .slice(0, 2)
                .map((user) => user.username)
                .join(
                  ', ',
                )}${typingUsers.length > 2 ? ` +${typingUsers.length - 2} others` : ''} are typing...`}
            {typingUsers.length === 0 && '\u00A0'}
          </p>}

          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              sendMessage();
            }}
          >
            <input
              value={draft}
              onChange={(event) => {
                const nextValue = event.target.value;
                setDraft(nextValue);

                if (chatMode !== 'channel') {
                  return;
                }

                const socket = socketRef.current;
                if (!socket || socket.readyState !== WebSocket.OPEN || !activeChannelId) {
                  return;
                }

                if (!nextValue.trim()) {
                  sendTypingStop(activeChannelId);
                  return;
                }

                if (!isTypingRef.current) {
                  socket.send(
                    JSON.stringify({
                      type: 'typing:start',
                      payload: { channelId: activeChannelId },
                    }),
                  );
                  isTypingRef.current = true;
                }

                queueTypingStop();
              }}
              onBlur={() => sendTypingStop()}
              placeholder={chatMode === 'dm' ? (activeDmThreadId ? 'Type a DM' : 'Select a DM thread') : activeChannelId ? 'Type a message' : 'Select a channel first'}
              aria-label="Message"
              maxLength={300}
            />
            <button
              type="submit"
              disabled={connectionState !== 'open' || !draft.trim() || (chatMode === 'dm' ? !activeDmThreadId : !activeChannelId)}
            >
              Send
            </button>
          </form>
        </section>

        <aside className="sidebar">
          <h3>Members</h3>
          <div className="list members-list">
            {members.map((member) => {
              const isOnline = Boolean(
                activeServerId &&
                (onlineUserIdsByServer[activeServerId] ?? []).includes(member.userId),
              );
              return (
                <div key={member.userId} className="member-row">
                  <span
                    className={isOnline ? 'presence-dot online' : 'presence-dot offline'}
                    aria-hidden="true"
                  />
                  <span>{member.username}</span>
                  <small className="subtle">{member.role}</small>
                </div>
              );
            })}
            {members.length === 0 && <p className="empty">No members yet.</p>}
          </div>
        </aside>
      </section>

      {error && <p className="error">{error}</p>}
    </main>
  );
}
