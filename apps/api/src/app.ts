import cors from 'cors';
import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  APP_NAME,
  type ChannelSummary,
  type ChatMessage,
  type ServerMember,
  type ServerSummary,
} from '@curly-broccoli/shared';
import {
  createAccessToken,
  createRefreshToken,
  hashPassword,
  hashToken,
  verifyAccessToken,
  verifyPassword,
  verifyRefreshToken,
} from './auth.js';

type UserRecord = {
  id: string;
  username: string;
  password_hash: string;
};

type RefreshTokenRecord = {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
};

type AppDependencies = {
  fetchRecentMessages: (channelId: string, limit?: number) => Promise<ChatMessage[]>;
  findUserByUsername: (username: string) => Promise<UserRecord | null>;
  findUserById: (id: string) => Promise<UserRecord | null>;
  createUser: (id: string, username: string, passwordHash: string) => Promise<UserRecord>;
  storeRefreshToken: (
    id: string,
    userId: string,
    tokenHash: string,
    expiresAt: string,
  ) => Promise<void>;
  findRefreshToken: (tokenHash: string) => Promise<RefreshTokenRecord | null>;
  revokeRefreshToken: (tokenHash: string) => Promise<void>;
  listServersForUser: (userId: string) => Promise<ServerSummary[]>;
  createServer: (id: string, name: string, ownerId: string) => Promise<ServerSummary>;
  addServerMembership: (
    serverId: string,
    userId: string,
    role: 'owner' | 'member',
  ) => Promise<void>;
  listChannelsForServer: (serverId: string, userId: string) => Promise<ChannelSummary[]>;
  createChannel: (
    id: string,
    serverId: string,
    name: string,
    userId: string,
  ) => Promise<ChannelSummary>;
  addMemberByUsername: (
    serverId: string,
    username: string,
    actorUserId: string,
  ) => Promise<{ userId: string; username: string } | null>;
  listServerMembers: (serverId: string, userId: string) => Promise<ServerMember[]>;
};

function validateAuthInput(username: string, password: string) {
  const normalizedUsername = username.trim().toLowerCase();
  const usernameValid = /^[a-z0-9_]{3,32}$/.test(normalizedUsername);
  const passwordValid = password.length >= 8 && password.length <= 128;

  return {
    ok: usernameValid && passwordValid,
    normalizedUsername,
    message: 'Username must be 3-32 chars (letters/numbers/_), password 8-128 chars.',
  };
}

function readBearerToken(authHeader?: string) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  return authHeader.slice('Bearer '.length);
}

function normalizeChannelName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 48);
}

export function createApp(deps: AppDependencies) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  function requireAuth(req: express.Request, res: express.Response) {
    const token = readBearerToken(req.header('authorization'));
    if (!token) {
      res.status(401).json({ error: 'Missing bearer token.' });
      return null;
    }

    try {
      return verifyAccessToken(token);
    } catch {
      res.status(401).json({ error: 'Invalid access token.' });
      return null;
    }
  }

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'api' });
  });

  app.post('/auth/register', async (req, res) => {
    const username = String(req.body?.username ?? '');
    const password = String(req.body?.password ?? '');
    const validation = validateAuthInput(username, password);

    if (!validation.ok) {
      res.status(400).json({ error: validation.message });
      return;
    }

    const existing = await deps.findUserByUsername(validation.normalizedUsername);
    if (existing) {
      res.status(409).json({ error: 'Username already exists.' });
      return;
    }

    const userId = randomUUID();
    const passwordHash = await hashPassword(password);
    const user = await deps.createUser(userId, validation.normalizedUsername, passwordHash);

    const refreshTokenId = randomUUID();
    const accessToken = createAccessToken({ id: user.id, username: user.username });
    const refreshToken = createRefreshToken(
      { id: user.id, username: user.username },
      refreshTokenId,
    );
    const refreshPayload = verifyRefreshToken(refreshToken);

    await deps.storeRefreshToken(
      refreshTokenId,
      user.id,
      hashToken(refreshToken),
      refreshPayload.expiresAt,
    );

    res.status(201).json({
      user: { id: user.id, username: user.username },
      tokens: { accessToken, refreshToken },
    });
  });

  app.post('/auth/login', async (req, res) => {
    const username = String(req.body?.username ?? '')
      .trim()
      .toLowerCase();
    const password = String(req.body?.password ?? '');

    if (!username || !password) {
      res.status(400).json({ error: 'Username and password are required.' });
      return;
    }

    const user = await deps.findUserByUsername(username);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    const refreshTokenId = randomUUID();
    const accessToken = createAccessToken({ id: user.id, username: user.username });
    const refreshToken = createRefreshToken(
      { id: user.id, username: user.username },
      refreshTokenId,
    );
    const refreshPayload = verifyRefreshToken(refreshToken);

    await deps.storeRefreshToken(
      refreshTokenId,
      user.id,
      hashToken(refreshToken),
      refreshPayload.expiresAt,
    );

    res.json({
      user: { id: user.id, username: user.username },
      tokens: { accessToken, refreshToken },
    });
  });

  app.post('/auth/refresh', async (req, res) => {
    const refreshToken = String(req.body?.refreshToken ?? '');
    if (!refreshToken) {
      res.status(400).json({ error: 'Refresh token is required.' });
      return;
    }

    try {
      const payload = verifyRefreshToken(refreshToken);
      const tokenHash = hashToken(refreshToken);
      const tokenRecord = await deps.findRefreshToken(tokenHash);

      const expired = Date.now() > new Date(payload.expiresAt).getTime();
      if (!tokenRecord || tokenRecord.revoked_at || expired) {
        res.status(401).json({ error: 'Refresh token is invalid or expired.' });
        return;
      }

      await deps.revokeRefreshToken(tokenHash);

      const nextRefreshTokenId = randomUUID();
      const accessToken = createAccessToken({ id: payload.userId, username: payload.username });
      const nextRefreshToken = createRefreshToken(
        { id: payload.userId, username: payload.username },
        nextRefreshTokenId,
      );
      const nextRefreshPayload = verifyRefreshToken(nextRefreshToken);

      await deps.storeRefreshToken(
        nextRefreshTokenId,
        payload.userId,
        hashToken(nextRefreshToken),
        nextRefreshPayload.expiresAt,
      );

      res.json({
        user: { id: payload.userId, username: payload.username },
        tokens: { accessToken, refreshToken: nextRefreshToken },
      });
    } catch {
      res.status(401).json({ error: 'Refresh token is invalid or expired.' });
    }
  });

  app.post('/auth/logout', async (req, res) => {
    const refreshToken = String(req.body?.refreshToken ?? '');
    if (refreshToken) {
      await deps.revokeRefreshToken(hashToken(refreshToken));
    }

    res.status(204).send();
  });

  app.get('/auth/me', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const user = await deps.findUserById(auth.userId);
    if (!user) {
      res.status(401).json({ error: 'Invalid access token.' });
      return;
    }

    res.json({ user: { id: user.id, username: user.username } });
  });

  app.get('/messages', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const channelId = String(req.query.channelId ?? '').trim();
    if (!channelId) {
      res.status(400).json({ error: 'channelId query param is required.' });
      return;
    }

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;

    const messages = await deps.fetchRecentMessages(channelId, limit);
    res.json({ messages });
  });

  app.get('/servers', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const servers = await deps.listServersForUser(auth.userId);
    res.json({ servers });
  });

  app.post('/servers', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const name = String(req.body?.name ?? '').trim();
    if (name.length < 2 || name.length > 64) {
      res.status(400).json({ error: 'Server name must be 2-64 characters.' });
      return;
    }

    const serverId = randomUUID();
    const server = await deps.createServer(serverId, name, auth.userId);
    await deps.addServerMembership(serverId, auth.userId, 'owner');
    res.status(201).json({ server });
  });

  app.get('/servers/:serverId/channels', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const channels = await deps.listChannelsForServer(req.params.serverId, auth.userId);
    res.json({ channels });
  });

  app.post('/servers/:serverId/channels', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const normalizedName = normalizeChannelName(String(req.body?.name ?? ''));
    if (normalizedName.length < 2) {
      res.status(400).json({ error: 'Channel name must have at least 2 valid characters.' });
      return;
    }

    try {
      const channel = await deps.createChannel(
        randomUUID(),
        req.params.serverId,
        normalizedName,
        auth.userId,
      );
      res.status(201).json({ channel });
    } catch {
      res.status(403).json({ error: 'Unable to create channel. Ensure you are a server member.' });
    }
  });

  app.get('/servers/:serverId/members', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    try {
      const members = await deps.listServerMembers(req.params.serverId, auth.userId);
      res.json({ members });
    } catch {
      res.status(403).json({ error: 'Unable to list members. Ensure you are a server member.' });
    }
  });

  app.post('/servers/:serverId/members', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const username = String(req.body?.username ?? '')
      .trim()
      .toLowerCase();
    if (!username) {
      res.status(400).json({ error: 'username is required.' });
      return;
    }

    try {
      const added = await deps.addMemberByUsername(req.params.serverId, username, auth.userId);
      if (!added) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }

      res.status(201).json({ member: added });
    } catch {
      res.status(403).json({ error: 'Only server owners can add members.' });
    }
  });

  app.get('/', (_req, res) => {
    res.send(`${APP_NAME} API says hello.`);
  });

  return app;
}
