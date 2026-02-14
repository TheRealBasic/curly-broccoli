import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type net from 'node:net';
import dotenv from 'dotenv';
import { type ChatMessage, type ClientEvent, type ServerEvent } from '@curly-broccoli/shared';
import { createApp } from './app.js';
import { chatHistoryLimit, fetchRecentMessages, runMigrations, saveMessage } from './db.js';

dotenv.config();

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const port = Number(process.env.API_PORT ?? 4000);
const app = createApp({ fetchRecentMessages });
const server = http.createServer(app);

const RATE_LIMIT_WINDOW_MS = 4_000;
const RATE_LIMIT_MAX_MESSAGES = 6;
const clients = new Set<net.Socket>();
const userByConnection = new Map<net.Socket, string>();
const sentTimestampsByConnection = new Map<net.Socket, number[]>();
const readBufferByConnection = new Map<net.Socket, Buffer>();

function randomName() {
  const adjectives = ['Swift', 'Blue', 'Mellow', 'Bold', 'Sunny', 'Brisk'];
  const nouns = ['Otter', 'Panda', 'Falcon', 'Fox', 'Bee', 'Cat'];
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const suffix = Math.floor(Math.random() * 900 + 100);
  return `${adjective}${noun}${suffix}`;
}

function encodeFrame(text: string) {
  const payload = Buffer.from(text);

  if (payload.length > 0xffff) {
    throw new Error('Payload too large for minimal server.');
  }

  if (payload.length <= 125) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }

  const lengthBytes = Buffer.alloc(2);
  lengthBytes.writeUInt16BE(payload.length, 0);
  return Buffer.concat([Buffer.from([0x81, 126]), lengthBytes, payload]);
}

function decodeFrames(buffer: Buffer) {
  const messagesOut: string[] = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];

    const opcode = first & 0x0f;
    if (opcode === 0x8) {
      return { messages: messagesOut, remaining: Buffer.alloc(0), shouldClose: true };
    }

    if (opcode !== 0x1) {
      return { messages: messagesOut, remaining: Buffer.alloc(0), shouldClose: true };
    }

    const masked = (second & 0x80) === 0x80;
    let length = second & 0x7f;
    let cursor = offset + 2;

    if (length === 126) {
      if (cursor + 2 > buffer.length) {
        break;
      }
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      return { messages: messagesOut, remaining: Buffer.alloc(0), shouldClose: true };
    }

    const maskLength = masked ? 4 : 0;
    const frameTotal = 2 + (length >= 126 ? 2 : 0) + maskLength + length;
    if (offset + frameTotal > buffer.length) {
      break;
    }

    let payload = buffer.subarray(cursor + maskLength, cursor + maskLength + length);
    if (masked) {
      const mask = buffer.subarray(cursor, cursor + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= mask[i % 4];
      }
    }

    messagesOut.push(payload.toString('utf8'));
    offset += frameTotal;
  }

  return { messages: messagesOut, remaining: buffer.subarray(offset), shouldClose: false };
}

function sendEvent(socket: net.Socket, event: ServerEvent) {
  socket.write(encodeFrame(JSON.stringify(event)));
}

function broadcast(event: ServerEvent) {
  const frame = encodeFrame(JSON.stringify(event));
  for (const client of clients) {
    client.write(frame);
  }
}

function isRateLimited(socket: net.Socket) {
  const now = Date.now();
  const timestamps = sentTimestampsByConnection.get(socket) ?? [];
  const recent = timestamps.filter((value) => now - value <= RATE_LIMIT_WINDOW_MS);

  if (recent.length >= RATE_LIMIT_MAX_MESSAGES) {
    sentTimestampsByConnection.set(socket, recent);
    return true;
  }

  recent.push(now);
  sentTimestampsByConnection.set(socket, recent);
  return false;
}

function closeConnection(socket: net.Socket) {
  clients.delete(socket);
  userByConnection.delete(socket);
  sentTimestampsByConnection.delete(socket);
  readBufferByConnection.delete(socket);
}

async function handleClientEvent(socket: net.Socket, raw: string) {
  let event: ClientEvent;

  try {
    event = JSON.parse(raw) as ClientEvent;
  } catch {
    sendEvent(socket, {
      type: 'error',
      payload: { message: 'Invalid JSON event.' }
    });
    return;
  }

  if (event.type === 'ping') {
    sendEvent(socket, { type: 'pong', payload: {} });
    return;
  }

  if (event.type !== 'chat:send') {
    sendEvent(socket, {
      type: 'error',
      payload: { message: 'Unsupported event type.' }
    });
    return;
  }

  const text = event.payload?.text?.trim();
  if (!text) {
    sendEvent(socket, {
      type: 'error',
      payload: { message: 'Message cannot be empty.' }
    });
    return;
  }

  if (isRateLimited(socket)) {
    sendEvent(socket, {
      type: 'error',
      payload: { message: 'Rate limit exceeded. Slow down a bit.' }
    });
    return;
  }

  const messageToSave: ChatMessage = {
    id: randomUUID(),
    user: userByConnection.get(socket) ?? 'Anonymous',
    text,
    createdAt: new Date().toISOString()
  };

  try {
    const message = await saveMessage(messageToSave);
    broadcast({
      type: 'chat:message',
      payload: { message }
    });
  } catch {
    sendEvent(socket, {
      type: 'error',
      payload: { message: 'Unable to save your message right now.' }
    });
  }
}

server.on('upgrade', (req, socket) => {
  if (req.url !== '/') {
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key || Array.isArray(key)) {
    socket.destroy();
    return;
  }

  const accept = createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n'
    ].join('\r\n')
  );

  clients.add(socket);
  const user = randomName();
  userByConnection.set(socket, user);
  sentTimestampsByConnection.set(socket, []);
  readBufferByConnection.set(socket, Buffer.alloc(0));

  sendEvent(socket, { type: 'system', payload: { text: `Connected as ${user}` } });
  void fetchRecentMessages(chatHistoryLimit)
    .then((messages) => {
      sendEvent(socket, { type: 'chat:history', payload: { messages } });
    })
    .catch(() => {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'Unable to load message history.' }
      });
    });

  socket.on('data', (chunk) => {
    const current = Buffer.concat([readBufferByConnection.get(socket) ?? Buffer.alloc(0), chunk]);
    const result = decodeFrames(current);
    readBufferByConnection.set(socket, result.remaining);

    for (const raw of result.messages) {
      void handleClientEvent(socket, raw);
    }

    if (result.shouldClose) {
      socket.end();
      closeConnection(socket);
    }
  });

  socket.on('close', () => {
    closeConnection(socket);
  });

  socket.on('error', () => {
    closeConnection(socket);
  });
});

void runMigrations()
  .then(() => {
    server.listen(port, () => {
      console.log(`API listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to run database migrations.', error);
    process.exit(1);
  });
