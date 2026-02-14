import cors from 'cors';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  APP_NAME,
  type ChannelSummary,
  type ChatMessage,
  type DmMessage,
  type DmThreadSummary,
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

type ModerationAuditLog = {
  id: string;
  serverId: string;
  actorUserId: string;
  actorUsername: string;
  targetUserId: string | null;
  targetUsername: string | null;
  messageId: string | null;
  action: 'message_delete' | 'message_report' | 'user_mute';
  details: unknown;
  createdAt: string;
};

type AppDependencies = {
  fetchRecentMessages: (channelId: string, limit?: number) => Promise<ChatMessage[]>;
  deleteMessageById: (
    messageId: string,
    actorUserId: string,
  ) => Promise<{
    id: string;
    channel_id: string;
    server_id: string;
    user_id: string | null;
    user_name: string;
    text: string;
    created_at: Date | string;
    can_delete: boolean;
  } | null>;
  reportMessageById: (
    messageId: string,
    actorUserId: string,
  ) => Promise<{
    id: string;
    channel_id: string;
    server_id: string;
    user_id: string | null;
    user_name: string;
    text: string;
    created_at: Date | string;
  } | null>;
  muteUserInServer: (
    serverId: string,
    targetUserId: string,
    actorUserId: string,
    reason: string | null,
  ) => Promise<void>;
  listModerationAuditLogs: (
    serverId: string,
    userId: string,
    limit?: number,
  ) => Promise<ModerationAuditLog[]>;
  writeModerationAuditLog: (entry: {
    id: string;
    serverId: string;
    actorUserId: string;
    targetUserId?: string | null;
    messageId?: string | null;
    action: 'message_delete' | 'message_report' | 'user_mute';
    details?: unknown;
  }) => Promise<void>;
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
  createOrGetDmThread: (userAId: string, userBId: string) => Promise<string>;
  listDmThreadsForUser: (userId: string) => Promise<DmThreadSummary[]>;
  fetchRecentDmMessages: (threadId: string, limit?: number) => Promise<DmMessage[]>;
  canAccessDmThread: (threadId: string, userId: string) => Promise<boolean>;
  canAccessChannel: (channelId: string, userId: string) => Promise<boolean>;
  createMessageAttachment: (attachment: {
    id: string;
    uploadedByUserId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    storagePath: string;
  }) => Promise<{
    id: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    url: string;
  }>;
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
  const uploadsDir = path.resolve(process.cwd(), 'uploads');
  const maxImageSizeBytes = 5 * 1024 * 1024;
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use('/uploads', express.static(uploadsDir));

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

  app.post('/uploads/images', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const channelId = String(req.body?.channelId ?? '').trim();
    const originalName = String(req.body?.fileName ?? '').trim();
    const mimeType = String(req.body?.mimeType ?? '')
      .trim()
      .toLowerCase();
    const base64Data = String(req.body?.fileDataBase64 ?? '').trim();

    if (!channelId) {
      res.status(400).json({ error: 'channelId is required.' });
      return;
    }

    if (!originalName || !mimeType || !base64Data) {
      res.status(400).json({ error: 'fileName, mimeType and fileDataBase64 are required.' });
      return;
    }

    if (!mimeType.startsWith('image/')) {
      res.status(415).json({ error: 'Only image files are allowed.' });
      return;
    }

    const allowed = await deps.canAccessChannel(channelId, auth.userId);
    if (!allowed) {
      res.status(403).json({ error: 'You cannot upload to this channel.' });
      return;
    }

    const fileBuffer = Buffer.from(base64Data, 'base64');
    if (fileBuffer.length === 0 || fileBuffer.length > maxImageSizeBytes) {
      res.status(400).json({ error: 'Image must be between 1 byte and 5MB.' });
      return;
    }

    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `${randomUUID()}-${safeName}`;
    const storagePath = path.posix.join('uploads', fileName);

    await mkdir(uploadsDir, { recursive: true });
    await writeFile(path.join(uploadsDir, fileName), fileBuffer);

    const attachment = await deps.createMessageAttachment({
      id: randomUUID(),
      uploadedByUserId: auth.userId,
      fileName: originalName,
      mimeType,
      sizeBytes: fileBuffer.length,
      storagePath,
    });

    res.status(201).json({ attachment });
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

  app.get('/dm/threads', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const threads = await deps.listDmThreadsForUser(auth.userId);
    res.json({ threads });
  });

  app.post('/dm/threads', async (req, res) => {
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

    const otherUser = await deps.findUserByUsername(username);
    if (!otherUser) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    if (otherUser.id === auth.userId) {
      res.status(400).json({ error: 'Cannot DM yourself.' });
      return;
    }

    const threadId = await deps.createOrGetDmThread(auth.userId, otherUser.id);
    const threads = await deps.listDmThreadsForUser(auth.userId);
    const thread = threads.find((item) => item.id === threadId);

    res.status(201).json({ threadId, thread: thread ?? null });
  });

  app.get('/dm/messages', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const threadId = String(req.query.threadId ?? '').trim();
    if (!threadId) {
      res.status(400).json({ error: 'threadId query param is required.' });
      return;
    }

    const allowed = await deps.canAccessDmThread(threadId, auth.userId);
    if (!allowed) {
      res.status(403).json({ error: 'You cannot access this DM thread.' });
      return;
    }

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;
    const messages = await deps.fetchRecentDmMessages(threadId, limit);
    res.json({ messages });
  });

  app.delete('/messages/:messageId', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const messageId = String(req.params.messageId ?? '').trim();
    if (!messageId) {
      res.status(400).json({ error: 'messageId is required.' });
      return;
    }

    const deleted = await deps.deleteMessageById(messageId, auth.userId);
    if (!deleted) {
      res.status(404).json({ error: 'Message not found or you cannot delete it.' });
      return;
    }

    await deps.writeModerationAuditLog({
      id: randomUUID(),
      serverId: deleted.server_id,
      actorUserId: auth.userId,
      targetUserId: deleted.user_id,
      messageId: deleted.id,
      action: 'message_delete',
      details: { channelId: deleted.channel_id },
    });

    res.status(204).send();
  });

  app.post('/messages/:messageId/report', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const messageId = String(req.params.messageId ?? '').trim();
    if (!messageId) {
      res.status(400).json({ error: 'messageId is required.' });
      return;
    }

    const reason = String(req.body?.reason ?? '').trim() || null;
    const reported = await deps.reportMessageById(messageId, auth.userId);
    if (!reported) {
      res.status(404).json({ error: 'Message not found or inaccessible.' });
      return;
    }

    await deps.writeModerationAuditLog({
      id: randomUUID(),
      serverId: reported.server_id,
      actorUserId: auth.userId,
      targetUserId: reported.user_id,
      messageId: reported.id,
      action: 'message_report',
      details: { reason },
    });

    res.status(201).json({ ok: true });
  });

  app.post('/servers/:serverId/mutes', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const targetUserId = String(req.body?.userId ?? '').trim();
    const reason = String(req.body?.reason ?? '').trim() || null;
    if (!targetUserId) {
      res.status(400).json({ error: 'userId is required.' });
      return;
    }

    try {
      await deps.muteUserInServer(req.params.serverId, targetUserId, auth.userId, reason);
      await deps.writeModerationAuditLog({
        id: randomUUID(),
        serverId: req.params.serverId,
        actorUserId: auth.userId,
        targetUserId,
        action: 'user_mute',
        details: { reason },
      });
      res.status(201).json({ ok: true });
    } catch {
      res.status(403).json({ error: 'Only server owners can mute members in this server.' });
    }
  });

  app.get('/servers/:serverId/audit-logs', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? limitRaw : undefined;

    try {
      const logs = await deps.listModerationAuditLogs(req.params.serverId, auth.userId, limit);
      res.json({ logs });
    } catch {
      res.status(403).json({ error: 'Only server owners can view audit logs.' });
    }
  });

  app.get('/', (_req, res) => {
    res.send(`${APP_NAME} API says hello.`);
  });

  return app;
}
