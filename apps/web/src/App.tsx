import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { APP_NAME, type ChatMessage, type ServerEvent } from '@curly-broccoli/shared';

type ConnectionState = 'connecting' | 'open' | 'closed';

type AuthState = {
  user: { id: string; username: string };
  accessToken: string;
  refreshToken: string;
};

type AuthMode = 'login' | 'register';

const AUTH_STORAGE_KEY = 'curly_broccoli_auth';

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

  const [auth, setAuth] = useState<AuthState | null>(() => loadAuthState());
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [usernameInput, setUsernameInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [connectionState, setConnectionState] = useState<ConnectionState>('closed');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [systemMessage, setSystemMessage] = useState('Sign in to join chat.');
  const [error, setError] = useState<string | null>(null);

  const wsUrl = useMemo(() => {
    if (!auth?.accessToken) {
      return null;
    }

    const base = apiBase.replace(/^http/, 'ws');
    return `${base}/?token=${encodeURIComponent(auth.accessToken)}`;
  }, [apiBase, auth?.accessToken]);

  function updateAuth(next: AuthState | null) {
    setAuth(next);
    saveAuthState(next);
  }

  async function refreshAuth(current: AuthState) {
    const res = await fetch(`${apiBase}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: current.refreshToken })
    });

    if (!res.ok) {
      throw new Error('Session expired. Please sign in again.');
    }

    const data = (await res.json()) as {
      user: { id: string; username: string };
      tokens: { accessToken: string; refreshToken: string };
    };

    const nextAuth: AuthState = {
      user: data.user,
      accessToken: data.tokens.accessToken,
      refreshToken: data.tokens.refreshToken
    };

    updateAuth(nextAuth);
    return nextAuth;
  }

  useEffect(() => {
    if (!auth) {
      setConnectionState('closed');
      setMessages([]);
      setSystemMessage('Sign in to join chat.');
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const meRes = await fetch(`${apiBase}/auth/me`, {
          headers: { Authorization: `Bearer ${auth.accessToken}` }
        });

        if (meRes.status === 401) {
          await refreshAuth(auth);
        }
      } catch {
        if (!cancelled) {
          updateAuth(null);
          setError('Session expired. Please sign in again.');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [apiBase, auth]);

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
        setMessages(parsed.payload.messages);
      }

      if (parsed.type === 'chat:message') {
        setMessages((prev) => [...prev, parsed.payload.message]);
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
      socket.close();
      socketRef.current = null;
    };
  }, [wsUrl, auth?.user.id]);

  function sendMessage() {
    const socket = socketRef.current;
    const text = draft.trim();
    if (!socket || socket.readyState !== WebSocket.OPEN || !text) {
      return;
    }

    socket.send(
      JSON.stringify({
        type: 'chat:send',
        payload: { text }
      })
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
      body: JSON.stringify({ username: usernameInput, password: passwordInput })
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
      refreshToken: data.tokens.refreshToken
    });

    setUsernameInput('');
    setPasswordInput('');
    setError(null);
  }

  async function logout() {
    if (auth?.refreshToken) {
      await fetch(`${apiBase}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: auth.refreshToken })
      });
    }

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
    <main className="chat-layout">
      <header className="chat-header">
        <div>
          <h1>{APP_NAME}</h1>
          <p className="subtle">Signed in as <strong>{auth.user.username}</strong></p>
          <p className="subtle">
            Status: <strong>{connectionState}</strong> · {systemMessage}
          </p>
        </div>
        <button type="button" className="logout-button" onClick={logout}>
          Logout
        </button>
      </header>

      <section className="chat-box" aria-label="Messages">
        {messages.length === 0 && <p className="empty">No messages yet.</p>}
        {messages.map((message) => (
          <article key={message.id} className="message">
            <header>
              <strong>{message.user}</strong>
              <time>{new Date(message.createdAt).toLocaleTimeString()}</time>
            </header>
            <p>{message.text}</p>
          </article>
        ))}
      </section>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          sendMessage();
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Type a message"
          aria-label="Message"
          maxLength={300}
        />
        <button type="submit" disabled={connectionState !== 'open' || !draft.trim()}>
          Send
        </button>
      </form>

      {error && <p className="error">{error}</p>}
    </main>
  );
}
