import { useEffect, useMemo, useRef, useState } from 'react';
import { APP_NAME, type ChatMessage, type ServerEvent } from '@curly-broccoli/shared';

type ConnectionState = 'connecting' | 'open' | 'closed';

export function App() {
  const apiBase = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000';
  const wsUrl = useMemo(() => apiBase.replace(/^http/, 'ws'), [apiBase]);
  const socketRef = useRef<WebSocket | null>(null);

  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [systemMessage, setSystemMessage] = useState('Connecting...');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;

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
    };
  }, [wsUrl]);

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

  return (
    <main className="chat-layout">
      <h1>{APP_NAME}</h1>
      <p className="subtle">Global room · anonymous chat</p>
      <p className="subtle">
        Status: <strong>{connectionState}</strong> · {systemMessage}
      </p>

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
