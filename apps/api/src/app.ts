import cors from 'cors';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { APP_NAME, type ChatMessage } from '@curly-broccoli/shared';
import {
  createAccessToken,
  createRefreshToken,
  hashPassword,
  hashToken,
  verifyAccessToken,
  verifyPassword,
  verifyRefreshToken
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
  fetchRecentMessages: (limit?: number) => Promise<ChatMessage[]>;
  findUserByUsername: (username: string) => Promise<UserRecord | null>;
  createUser: (id: string, username: string, passwordHash: string) => Promise<UserRecord>;
  storeRefreshToken: (id: string, userId: string, tokenHash: string, expiresAt: string) => Promise<void>;
  findRefreshToken: (tokenHash: string) => Promise<RefreshTokenRecord | null>;
  revokeRefreshToken: (tokenHash: string) => Promise<void>;
};

function validateAuthInput(username: string, password: string) {
  const normalizedUsername = username.trim().toLowerCase();
  const usernameValid = /^[a-z0-9_]{3,32}$/.test(normalizedUsername);
  const passwordValid = password.length >= 8 && password.length <= 128;

  return {
    ok: usernameValid && passwordValid,
    normalizedUsername,
    message: 'Username must be 3-32 chars (letters/numbers/_), password 8-128 chars.'
  };
}

function readBearerToken(authHeader?: string) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  return authHeader.slice('Bearer '.length);
}

export function createApp(deps: AppDependencies) {
  const app = express();
  app.use(cors());
  app.use(express.json());

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
    const refreshToken = createRefreshToken({ id: user.id, username: user.username }, refreshTokenId);
    const refreshPayload = verifyRefreshToken(refreshToken);

    await deps.storeRefreshToken(
      refreshTokenId,
      user.id,
      hashToken(refreshToken),
      refreshPayload.expiresAt
    );

    res.status(201).json({
      user: { id: user.id, username: user.username },
      tokens: { accessToken, refreshToken }
    });
  });

  app.post('/auth/login', async (req, res) => {
    const username = String(req.body?.username ?? '').trim().toLowerCase();
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
    const refreshToken = createRefreshToken({ id: user.id, username: user.username }, refreshTokenId);
    const refreshPayload = verifyRefreshToken(refreshToken);

    await deps.storeRefreshToken(
      refreshTokenId,
      user.id,
      hashToken(refreshToken),
      refreshPayload.expiresAt
    );

    res.json({
      user: { id: user.id, username: user.username },
      tokens: { accessToken, refreshToken }
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
        nextRefreshTokenId
      );
      const nextRefreshPayload = verifyRefreshToken(nextRefreshToken);

      await deps.storeRefreshToken(
        nextRefreshTokenId,
        payload.userId,
        hashToken(nextRefreshToken),
        nextRefreshPayload.expiresAt
      );

      res.json({
        user: { id: payload.userId, username: payload.username },
        tokens: { accessToken, refreshToken: nextRefreshToken }
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

  app.get('/auth/me', (req, res) => {
    const token = readBearerToken(req.header('authorization'));
    if (!token) {
      res.status(401).json({ error: 'Missing bearer token.' });
      return;
    }

    try {
      const payload = verifyAccessToken(token);
      res.json({ user: { id: payload.userId, username: payload.username } });
    } catch {
      res.status(401).json({ error: 'Invalid access token.' });
    }
  });

  app.get('/messages', async (req, res) => {
    const token = readBearerToken(req.header('authorization'));

    if (!token) {
      res.status(401).json({ error: 'Missing bearer token.' });
      return;
    }

    try {
      verifyAccessToken(token);
    } catch {
      res.status(401).json({ error: 'Invalid access token.' });
      return;
    }

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;

    const messages = await deps.fetchRecentMessages(limit);
    res.json({ messages });
  });

  app.get('/', (_req, res) => {
    res.send(`${APP_NAME} API says hello.`);
  });

  return app;
}
