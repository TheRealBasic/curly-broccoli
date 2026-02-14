import cors from 'cors';
import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  APP_NAME,
  type AttachmentCategory,
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
  action:
    | 'message_delete'
    | 'message_report'
    | 'user_mute'
    | 'user_unmute'
    | 'member_permission_update'
    | 'screen_share_start'
    | 'screen_share_stop'
    | 'screen_share_force_stop'
    | 'message_edit';
  details: unknown;
  createdAt: string;
};

type CursorPage<T> = {
  messages: T[];
  nextCursor: string | null;
  prevCursor: string | null;
};

type AppDependencies = {
  fetchRecentMessages: (
    channelId: string,
    options?: { limit?: number; before?: string; after?: string; offset?: number },
  ) => Promise<CursorPage<ChatMessage>>;
  updateMessageById: (
    messageId: string,
    actorUserId: string,
    newText: string,
  ) => Promise<{
    id: string;
    channel_id: string;
    server_id: string;
    user_id: string | null;
    user_name: string;
    text: string;
    created_at: Date | string;
    edited_at: Date | string | null;
    can_edit: boolean;
  } | null>;
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
  unmuteUserInServer: (serverId: string, targetUserId: string, actorUserId: string) => Promise<void>;
  updateMemberScreenSharePermission: (
    serverId: string,
    targetUserId: string,
    canShare: boolean,
    actorUserId: string,
  ) => Promise<void>;
  updateServerAudioSettings: (
    serverId: string,
    actorUserId: string,
    input: { soundboardEnabled: boolean; voiceEffectsEnabled: boolean },
  ) => Promise<ServerSummary>;
  getServerAiSettings: (serverId: string) => Promise<{
    serverId: string;
    enabled: boolean;
    botDisplayName: string;
    model: string;
    systemPrompt: string | null;
    maxTokensPerReply: number | null;
    maxPromptChars: number | null;
    maxCompletionTokens: number | null;
    rateLimitUserRequests: number | null;
    rateLimitServerRequests: number | null;
    rateLimitWindowSeconds: number | null;
    burstLimitRequests: number | null;
    burstWindowSeconds: number | null;
    dailyTokenBudget: number | null;
    monthlyTokenBudget: number | null;
    autoDisableOnBudgetExceeded: boolean;
    disabledReason: string | null;
    temperature: number | null;
    allowDmInvocation: boolean;
    invocationPolicy: 'everyone' | 'roles';
  } | null>;
  updateServerAiSettings: (
    serverId: string,
    actorUserId: string,
    patch: {
      enabled?: boolean;
      botDisplayName?: string;
      model?: string;
      systemPrompt?: string | null;
      maxTokensPerReply?: number | null;
      maxPromptChars?: number | null;
      maxCompletionTokens?: number | null;
      rateLimitUserRequests?: number | null;
      rateLimitServerRequests?: number | null;
      rateLimitWindowSeconds?: number | null;
      burstLimitRequests?: number | null;
      burstWindowSeconds?: number | null;
      dailyTokenBudget?: number | null;
      monthlyTokenBudget?: number | null;
      autoDisableOnBudgetExceeded?: boolean;
      disabledReason?: string | null;
      temperature?: number | null;
      allowDmInvocation?: boolean;
      invocationPolicy?: 'everyone' | 'roles';
    },
  ) => Promise<{
    serverId: string;
    enabled: boolean;
    botDisplayName: string;
    model: string;
    systemPrompt: string | null;
    maxTokensPerReply: number | null;
    temperature: number | null;
    allowDmInvocation: boolean;
    invocationPolicy: 'everyone' | 'roles';
  }>;
  listModerationAuditLogs: (
    serverId: string,
    userId: string,
    limit?: number,
  ) => Promise<ModerationAuditLog[]>;
  notifyMessageEdited: (event: {
    channelId: string;
    messageId: string;
    text: string;
    editedAt: string;
  }) => void;
  writeModerationAuditLog: (entry: {
    id: string;
    serverId: string;
    actorUserId: string;
    targetUserId?: string | null;
    messageId?: string | null;
    action:
      | 'message_delete'
      | 'message_report'
      | 'user_mute'
      | 'user_unmute'
      | 'member_permission_update'
      | 'screen_share_start'
      | 'screen_share_stop'
      | 'screen_share_force_stop'
      | 'message_edit';
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
  fetchRecentDmMessages: (
    threadId: string,
    options?: { limit?: number; before?: string; after?: string; offset?: number },
  ) => Promise<CursorPage<DmMessage>>;
  searchChannelMessages: (
    channelId: string,
    query: string,
    options?: { limit?: number; before?: string; after?: string; offset?: number },
  ) => Promise<CursorPage<ChatMessage>>;
  searchDmMessages: (
    threadId: string,
    query: string,
    options?: { limit?: number; before?: string; after?: string; offset?: number },
  ) => Promise<CursorPage<DmMessage>>;
  canAccessDmThread: (threadId: string, userId: string) => Promise<boolean>;
  canAccessChannel: (channelId: string, userId: string) => Promise<boolean>;
  createMessageAttachment: (attachment: {
    id: string;
    uploadedByUserId: string;
    fileName: string;
    mimeType: string;
    category: AttachmentCategory;
    sizeBytes: number;
    storagePath: string;
  }) => Promise<{
    id: string;
    fileName: string;
    mimeType: string;
    category: AttachmentCategory;
    sizeBytes: number;
    url: string;
  }>;
  markChannelAsRead: (userId: string, channelId: string, lastReadMessageId?: string) => Promise<void>;
  markDmThreadAsRead: (userId: string, threadId: string, lastReadMessageId?: string) => Promise<void>;
  getUnreadSummary: (userId: string) => Promise<{
    channels: Record<string, number>;
    dmThreads: Record<string, number>;
    totalChannels: number;
    totalDmThreads: number;
  }>;
  notifyUnreadUpdated?: (event: {
    userId: string;
    summary: {
      channels: Record<string, number>;
      dmThreads: Record<string, number>;
      totalChannels: number;
      totalDmThreads: number;
    };
  }) => void;
};

type RequestMetric = {
  total: number;
  byRoute: Map<string, number>;
  byStatus: Map<string, number>;
};

type UploadPolicyRule = {
  category: AttachmentCategory;
  mimePrefixes: string[];
  maxSizeBytes: number;
};

type UploadPolicyConfig = {
  allowedCategories: AttachmentCategory[];
  rules: UploadPolicyRule[];
  antivirusScan?: (file: { fileName: string; mimeType: string; buffer: Buffer }) => Promise<void>;
};

const uploadPolicy: UploadPolicyConfig = {
  allowedCategories: ['image', 'audio', 'video', 'document'],
  rules: [
    { category: 'image', mimePrefixes: ['image/'], maxSizeBytes: 5 * 1024 * 1024 },
    { category: 'audio', mimePrefixes: ['audio/'], maxSizeBytes: 15 * 1024 * 1024 },
    { category: 'video', mimePrefixes: ['video/'], maxSizeBytes: 25 * 1024 * 1024 },
    {
      category: 'document',
      mimePrefixes: ['text/', 'application/'],
      maxSizeBytes: 10 * 1024 * 1024,
    },
  ],
};


const clipUploadPolicy = {
  allowedMimeTypes: new Set(['video/webm', 'audio/webm']),
  maxSizeBytes: 20 * 1024 * 1024,
};
const maxUploadSizeBytes = Math.max(...uploadPolicy.rules.map((rule) => rule.maxSizeBytes));

function getUploadPolicyRule(mimeType: string) {
  return uploadPolicy.rules.find((rule) =>
    rule.mimePrefixes.some((prefix) => mimeType.startsWith(prefix)),
  );
}

function parseAllowedOrigins(raw: string | undefined) {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}


function resolveMembershipErrorStatus(error: unknown) {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return null;
  }

  if ((error as { code?: unknown }).code === 'TARGET_NOT_MEMBER') {
    return 404;
  }

  return 403;
}

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

function parsePositiveInt(value: unknown, max: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    return null;
  }

  return parsed;
}

function parseNonNegativeInt(value: unknown, max: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > max) {
    return null;
  }

  return parsed;
}

function createRateLimiter(maxRequests: number, windowMs: number) {
  const buckets = new Map<string, number[]>();

  return function check(key: string) {
    const now = Date.now();
    const entries = buckets.get(key) ?? [];
    const fresh = entries.filter((timestamp) => now - timestamp < windowMs);

    if (fresh.length >= maxRequests) {
      buckets.set(key, fresh);
      return false;
    }

    fresh.push(now);
    buckets.set(key, fresh);
    return true;
  };
}

export function createApp(deps: AppDependencies) {
  const app = express();
  const startedAt = Date.now();
  const metrics: RequestMetric = {
    total: 0,
    byRoute: new Map(),
    byStatus: new Map(),
  };

  const allowedOrigins = parseAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS);
  const uploadsDir = path.resolve(process.cwd(), 'uploads');
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadSizeBytes },
  });
  const maxSearchLimit = 100;
  const checkAuthRateLimit = createRateLimiter(
    Number(process.env.AUTH_RATE_LIMIT_MAX ?? 20),
    Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS ?? 60_000),
  );

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const started = process.hrtime.bigint();

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      const route = req.route?.path
        ? `${req.method} ${String(req.route.path)}`
        : `${req.method} ${req.path}`;
      const status = String(res.statusCode);

      metrics.total += 1;
      metrics.byRoute.set(route, (metrics.byRoute.get(route) ?? 0) + 1);
      metrics.byStatus.set(status, (metrics.byStatus.get(status) ?? 0) + 1);

      console.info(
        JSON.stringify({
          level: 'info',
          message: 'http_request',
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          durationMs: Number(durationMs.toFixed(2)),
          requestId: res.getHeader('x-request-id'),
        }),
      );
    });

    next();
  });

  app.use((req, res, next) => {
    res.setHeader('X-Request-Id', randomUUID());
    next();
  });

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error('Origin not allowed by CORS policy.'));
      },
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: '1mb' }));
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


  function buildAiStatus(settings: { enabled: boolean; disabledReason: string | null; model: string }) {
    const keyMissing = !process.env.OPENAI_API_KEY?.trim();
    const reason = settings.disabledReason?.toLowerCase() ?? '';
    const budgetReached = reason.includes('budget');
    const degradedMode = settings.enabled && settings.model.toLowerCase().includes('mini');
    return {
      enabled: settings.enabled,
      keyMissing,
      budgetReached,
      degradedMode,
    };
  }

  function enforceAuthRateLimit(req: express.Request, res: express.Response) {
    const key = `${req.ip}:${req.path}`;
    if (checkAuthRateLimit(key)) {
      return true;
    }

    res.status(429).json({ error: 'Too many auth requests. Please try again shortly.' });
    return false;
  }

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'api' });
  });

  app.get('/metrics', (_req, res) => {
    const routeMetrics = [...metrics.byRoute.entries()].map(([route, count]) => ({ route, count }));
    const statusMetrics = [...metrics.byStatus.entries()].map(([statusCode, count]) => ({
      statusCode,
      count,
    }));

    res.json({
      ok: true,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      requests: {
        total: metrics.total,
        byRoute: routeMetrics,
        byStatusCode: statusMetrics,
      },
    });
  });

  app.post('/auth/register', async (req, res) => {
    if (!enforceAuthRateLimit(req, res)) {
      return;
    }

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
    if (!enforceAuthRateLimit(req, res)) {
      return;
    }

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
    if (!enforceAuthRateLimit(req, res)) {
      return;
    }

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

    const allowed = await deps.canAccessChannel(channelId, auth.userId);
    if (!allowed) {
      res.status(403).json({ error: 'You cannot access this channel.' });
      return;
    }

    const limit =
      req.query.limit === undefined ? undefined : parsePositiveInt(req.query.limit, maxSearchLimit);
    if (req.query.limit !== undefined && limit === null) {
      res.status(400).json({ error: `limit must be an integer between 1 and ${maxSearchLimit}.` });
      return;
    }

    const before = req.query.before === undefined ? undefined : String(req.query.before).trim();
    const after = req.query.after === undefined ? undefined : String(req.query.after).trim();
    const offset =
      req.query.offset === undefined ? undefined : parseNonNegativeInt(req.query.offset, 1_000_000);
    if (req.query.offset !== undefined && offset === null) {
      res.status(400).json({ error: 'offset must be a non-negative integer.' });
      return;
    }

    try {
      const page = await deps.fetchRecentMessages(channelId, {
        limit: limit ?? undefined,
        before: before || undefined,
        after: after || undefined,
        offset: offset ?? undefined,
      });
      res.json(page);
    } catch {
      res.status(400).json({ error: 'Invalid before/after cursor.' });
    }
  });

  app.get('/messages/search', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const channelId = String(req.query.channelId ?? '').trim();
    const query = String(req.query.query ?? '').trim();
    if (!channelId || !query) {
      res.status(400).json({ error: 'channelId and query query params are required.' });
      return;
    }

    const allowed = await deps.canAccessChannel(channelId, auth.userId);
    if (!allowed) {
      res.status(403).json({ error: 'You cannot access this channel.' });
      return;
    }

    const limit =
      req.query.limit === undefined ? undefined : parsePositiveInt(req.query.limit, maxSearchLimit);
    if (req.query.limit !== undefined && limit === null) {
      res.status(400).json({ error: `limit must be an integer between 1 and ${maxSearchLimit}.` });
      return;
    }

    const offset =
      req.query.offset === undefined ? undefined : parseNonNegativeInt(req.query.offset, 1_000_000);
    if (req.query.offset !== undefined && offset === null) {
      res.status(400).json({ error: 'offset must be a non-negative integer.' });
      return;
    }

    const before = req.query.before === undefined ? undefined : String(req.query.before).trim();
    const after = req.query.after === undefined ? undefined : String(req.query.after).trim();

    try {
      const page = await deps.searchChannelMessages(channelId, query, {
        limit,
        offset,
        before: before || undefined,
        after: after || undefined,
      });
      res.json(page);
    } catch {
      res.status(400).json({ error: 'Invalid before/after cursor.' });
    }
  });


  async function persistAttachmentUpload(params: {
    authUserId: string;
    channelId: string;
    originalName: string;
    mimeType: string;
    fileBuffer: Buffer;
  }) {
    const allowed = await deps.canAccessChannel(params.channelId, params.authUserId);
    if (!allowed) {
      return { error: { status: 403, message: 'You cannot upload to this channel.' } } as const;
    }

    const policyRule = getUploadPolicyRule(params.mimeType);
    if (!policyRule || !uploadPolicy.allowedCategories.includes(policyRule.category)) {
      return { error: { status: 415, message: 'This file type is not allowed.' } } as const;
    }

    if (params.fileBuffer.length === 0 || params.fileBuffer.length > policyRule.maxSizeBytes) {
      return {
        error: {
          status: 400,
          message: `Attachment must be between 1 byte and ${Math.floor(policyRule.maxSizeBytes / 1024 / 1024)}MB for ${policyRule.category} files.`,
        },
      } as const;
    }

    if (uploadPolicy.antivirusScan) {
      await uploadPolicy.antivirusScan({
        fileName: params.originalName,
        mimeType: params.mimeType,
        buffer: params.fileBuffer,
      });
    }

    const safeName = params.originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = `${randomUUID()}-${safeName}`;
    const storagePath = path.posix.join('uploads', fileName);

    await mkdir(uploadsDir, { recursive: true });
    await writeFile(path.join(uploadsDir, fileName), params.fileBuffer);

    const attachment = await deps.createMessageAttachment({
      id: randomUUID(),
      uploadedByUserId: params.authUserId,
      fileName: params.originalName,
      mimeType: params.mimeType,
      category: policyRule.category,
      sizeBytes: params.fileBuffer.length,
      storagePath,
    });

    return { attachment } as const;
  }


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

    const result = await persistAttachmentUpload({
      authUserId: auth.userId,
      channelId,
      originalName,
      mimeType,
      fileBuffer: Buffer.from(base64Data, 'base64'),
    });

    if ('error' in result) {
      res.status(result.error.status).json({ error: result.error.message });
      return;
    }

    res.status(201).json({ attachment: result.attachment });
  });

  app.post('/uploads/attachments', upload.single('file'), async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const channelId = String(req.body?.channelId ?? '').trim();
    const file = req.file;

    if (!channelId) {
      res.status(400).json({ error: 'channelId is required.' });
      return;
    }

    if (!file) {
      res.status(400).json({ error: 'file is required.' });
      return;
    }

    const mimeType = String(file.mimetype ?? '').trim().toLowerCase();
    const uploadKind = String(req.body?.uploadKind ?? '').trim().toLowerCase();
    if (uploadKind === 'clip') {
      if (!clipUploadPolicy.allowedMimeTypes.has(mimeType)) {
        res.status(415).json({ error: 'Clip uploads must be .webm audio/video files.' });
        return;
      }
      if (file.buffer.length > clipUploadPolicy.maxSizeBytes) {
        res.status(400).json({ error: 'Clip uploads are limited to 20MB.' });
        return;
      }
    }

    const result = await persistAttachmentUpload({
      authUserId: auth.userId,
      channelId,
      originalName: file.originalname,
      mimeType,
      fileBuffer: file.buffer,
    });

    if ('error' in result) {
      res.status(result.error.status).json({ error: result.error.message });
      return;
    }

    res.status(201).json({ attachment: result.attachment });
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

    const limit =
      req.query.limit === undefined ? undefined : parsePositiveInt(req.query.limit, maxSearchLimit);
    if (req.query.limit !== undefined && limit === null) {
      res.status(400).json({ error: `limit must be an integer between 1 and ${maxSearchLimit}.` });
      return;
    }

    const before = req.query.before === undefined ? undefined : String(req.query.before).trim();
    const after = req.query.after === undefined ? undefined : String(req.query.after).trim();
    const offset =
      req.query.offset === undefined ? undefined : parseNonNegativeInt(req.query.offset, 1_000_000);
    if (req.query.offset !== undefined && offset === null) {
      res.status(400).json({ error: 'offset must be a non-negative integer.' });
      return;
    }

    try {
      const page = await deps.fetchRecentDmMessages(threadId, {
        limit: limit ?? undefined,
        before: before || undefined,
        after: after || undefined,
        offset: offset ?? undefined,
      });
      res.json(page);
    } catch {
      res.status(400).json({ error: 'Invalid before/after cursor.' });
    }
  });

  app.get('/dm/messages/search', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const threadId = String(req.query.threadId ?? '').trim();
    const query = String(req.query.query ?? '').trim();
    if (!threadId || !query) {
      res.status(400).json({ error: 'threadId and query query params are required.' });
      return;
    }

    const allowed = await deps.canAccessDmThread(threadId, auth.userId);
    if (!allowed) {
      res.status(403).json({ error: 'You cannot access this DM thread.' });
      return;
    }

    const limit =
      req.query.limit === undefined ? undefined : parsePositiveInt(req.query.limit, maxSearchLimit);
    if (req.query.limit !== undefined && limit === null) {
      res.status(400).json({ error: `limit must be an integer between 1 and ${maxSearchLimit}.` });
      return;
    }

    const offset =
      req.query.offset === undefined ? undefined : parseNonNegativeInt(req.query.offset, 1_000_000);
    if (req.query.offset !== undefined && offset === null) {
      res.status(400).json({ error: 'offset must be a non-negative integer.' });
      return;
    }

    const before = req.query.before === undefined ? undefined : String(req.query.before).trim();
    const after = req.query.after === undefined ? undefined : String(req.query.after).trim();

    try {
      const page = await deps.searchDmMessages(threadId, query, {
        limit,
        offset,
        before: before || undefined,
        after: after || undefined,
      });
      res.json(page);
    } catch {
      res.status(400).json({ error: 'Invalid before/after cursor.' });
    }
  });

  app.get('/unread/summary', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const summary = await deps.getUnreadSummary(auth.userId);
    res.json({ summary });
  });

  app.post('/channels/:channelId/read', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const channelId = String(req.params.channelId ?? '').trim();
    if (!channelId) {
      res.status(400).json({ error: 'channelId is required.' });
      return;
    }

    const allowed = await deps.canAccessChannel(channelId, auth.userId);
    if (!allowed) {
      res.status(403).json({ error: 'You cannot access this channel.' });
      return;
    }

    const lastReadMessageId =
      req.body?.lastReadMessageId === undefined ? undefined : String(req.body?.lastReadMessageId ?? '').trim();

    try {
      await deps.markChannelAsRead(auth.userId, channelId, lastReadMessageId || undefined);
      const summary = await deps.getUnreadSummary(auth.userId);
      deps.notifyUnreadUpdated?.({ userId: auth.userId, summary });
      res.status(204).send();
    } catch {
      res.status(400).json({ error: 'Invalid read marker payload.' });
    }
  });

  app.post('/dm/threads/:threadId/read', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const threadId = String(req.params.threadId ?? '').trim();
    if (!threadId) {
      res.status(400).json({ error: 'threadId is required.' });
      return;
    }

    const allowed = await deps.canAccessDmThread(threadId, auth.userId);
    if (!allowed) {
      res.status(403).json({ error: 'You cannot access this DM thread.' });
      return;
    }

    const lastReadMessageId =
      req.body?.lastReadMessageId === undefined ? undefined : String(req.body?.lastReadMessageId ?? '').trim();

    try {
      await deps.markDmThreadAsRead(auth.userId, threadId, lastReadMessageId || undefined);
      const summary = await deps.getUnreadSummary(auth.userId);
      deps.notifyUnreadUpdated?.({ userId: auth.userId, summary });
      res.status(204).send();
    } catch {
      res.status(400).json({ error: 'Invalid read marker payload.' });
    }
  });

  app.patch('/messages/:messageId', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const messageId = String(req.params.messageId ?? '').trim();
    if (!messageId) {
      res.status(400).json({ error: 'messageId is required.' });
      return;
    }

    const text = String(req.body?.text ?? '').trim();
    if (!text || text.length > 300) {
      res.status(400).json({ error: 'text must be between 1 and 300 characters.' });
      return;
    }

    const updated = await deps.updateMessageById(messageId, auth.userId, text);
    if (!updated) {
      res.status(404).json({ error: 'Message not found or you cannot edit it.' });
      return;
    }

    await deps.writeModerationAuditLog({
      id: randomUUID(),
      serverId: updated.server_id,
      actorUserId: auth.userId,
      targetUserId: updated.user_id,
      messageId: updated.id,
      action: 'message_edit',
      details: { channelId: updated.channel_id },
    });

    const editedAt = new Date(updated.edited_at ?? new Date()).toISOString();

    deps.notifyMessageEdited({
      channelId: updated.channel_id,
      messageId: updated.id,
      text: updated.text,
      editedAt,
    });

    res.status(200).json({
      message: {
        id: updated.id,
        channelId: updated.channel_id,
        text: updated.text,
        editedAt,
      },
    });
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
    } catch (error) {
      const status = resolveMembershipErrorStatus(error);
      if (status === 404) {
        res.status(404).json({ error: 'Target member was not found in this server.' });
        return;
      }

      res.status(403).json({ error: 'Only server owners can mute members in this server.' });
    }
  });

  app.delete('/servers/:serverId/mutes/:userId', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const targetUserId = String(req.params.userId ?? '').trim();
    if (!targetUserId) {
      res.status(400).json({ error: 'userId is required.' });
      return;
    }

    try {
      await deps.unmuteUserInServer(req.params.serverId, targetUserId, auth.userId);
      await deps.writeModerationAuditLog({
        id: randomUUID(),
        serverId: req.params.serverId,
        actorUserId: auth.userId,
        targetUserId,
        action: 'user_unmute',
      });
      res.status(204).send();
    } catch (error) {
      const status = resolveMembershipErrorStatus(error);
      if (status === 404) {
        res.status(404).json({ error: 'Target member was not found in this server.' });
        return;
      }

      res.status(403).json({ error: 'Only server owners can unmute members in this server.' });
    }
  });


  app.patch('/servers/:serverId/audio-settings', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const serverId = req.params.serverId;
    const soundboardEnabled = req.body?.soundboardEnabled;
    const voiceEffectsEnabled = req.body?.voiceEffectsEnabled;
    if (typeof soundboardEnabled !== 'boolean' || typeof voiceEffectsEnabled !== 'boolean') {
      res.status(400).json({ error: 'soundboardEnabled and voiceEffectsEnabled must be booleans.' });
      return;
    }

    try {
      const server = await deps.updateServerAudioSettings(serverId, auth.userId, {
        soundboardEnabled,
        voiceEffectsEnabled,
      });
      res.json({ server });
    } catch {
      res.status(403).json({ error: 'Only server owners can update audio settings in this server.' });
    }
  });

  app.get('/servers/:serverId/ai-settings', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    try {
      await deps.listServerMembers(req.params.serverId, auth.userId);
    } catch {
      res.status(403).json({ error: 'You are not a member of this server.' });
      return;
    }

    const settings = await deps.getServerAiSettings(req.params.serverId);
    if (!settings) {
      res.status(404).json({ error: 'Server not found.' });
      return;
    }

    res.json({ settings: { ...settings, status: buildAiStatus(settings) } });
  });

  app.patch('/servers/:serverId/ai-settings', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const patch: {
      enabled?: boolean;
      botDisplayName?: string;
      model?: string;
      systemPrompt?: string | null;
      maxTokensPerReply?: number | null;
      maxPromptChars?: number | null;
      maxCompletionTokens?: number | null;
      rateLimitUserRequests?: number | null;
      rateLimitServerRequests?: number | null;
      rateLimitWindowSeconds?: number | null;
      burstLimitRequests?: number | null;
      burstWindowSeconds?: number | null;
      dailyTokenBudget?: number | null;
      monthlyTokenBudget?: number | null;
      autoDisableOnBudgetExceeded?: boolean;
      disabledReason?: string | null;
      temperature?: number | null;
      allowDmInvocation?: boolean;
      invocationPolicy?: 'everyone' | 'roles';
    } = {};

    if ('enabled' in req.body) {
      if (typeof req.body.enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean.' });
        return;
      }
      patch.enabled = req.body.enabled;
    }

    if ('botDisplayName' in req.body) {
      if (typeof req.body.botDisplayName !== 'string' || req.body.botDisplayName.trim().length === 0) {
        res.status(400).json({ error: 'botDisplayName must be a non-empty string.' });
        return;
      }
      patch.botDisplayName = req.body.botDisplayName.trim();
    }

    if ('model' in req.body) {
      if (typeof req.body.model !== 'string' || req.body.model.trim().length === 0) {
        res.status(400).json({ error: 'model must be a non-empty string.' });
        return;
      }
      patch.model = req.body.model.trim();
    }

    if ('systemPrompt' in req.body) {
      if (req.body.systemPrompt !== null && typeof req.body.systemPrompt !== 'string') {
        res.status(400).json({ error: 'systemPrompt must be a string or null.' });
        return;
      }
      patch.systemPrompt = req.body.systemPrompt;
    }

    if ('maxTokensPerReply' in req.body) {
      if (req.body.maxTokensPerReply !== null && (!Number.isInteger(req.body.maxTokensPerReply) || req.body.maxTokensPerReply <= 0)) {
        res.status(400).json({ error: 'maxTokensPerReply must be a positive integer or null.' });
        return;
      }
      patch.maxTokensPerReply = req.body.maxTokensPerReply;
    }


    if ('maxPromptChars' in req.body) {
      if (req.body.maxPromptChars !== null && (!Number.isInteger(req.body.maxPromptChars) || req.body.maxPromptChars <= 0)) {
        res.status(400).json({ error: 'maxPromptChars must be a positive integer or null.' });
        return;
      }
      patch.maxPromptChars = req.body.maxPromptChars;
    }

    if ('maxCompletionTokens' in req.body) {
      if (req.body.maxCompletionTokens !== null && (!Number.isInteger(req.body.maxCompletionTokens) || req.body.maxCompletionTokens <= 0)) {
        res.status(400).json({ error: 'maxCompletionTokens must be a positive integer or null.' });
        return;
      }
      patch.maxCompletionTokens = req.body.maxCompletionTokens;
    }

    if ('rateLimitUserRequests' in req.body) {
      if (req.body.rateLimitUserRequests !== null && (!Number.isInteger(req.body.rateLimitUserRequests) || req.body.rateLimitUserRequests <= 0)) {
        res.status(400).json({ error: 'rateLimitUserRequests must be a positive integer or null.' });
        return;
      }
      patch.rateLimitUserRequests = req.body.rateLimitUserRequests;
    }

    if ('rateLimitServerRequests' in req.body) {
      if (req.body.rateLimitServerRequests !== null && (!Number.isInteger(req.body.rateLimitServerRequests) || req.body.rateLimitServerRequests <= 0)) {
        res.status(400).json({ error: 'rateLimitServerRequests must be a positive integer or null.' });
        return;
      }
      patch.rateLimitServerRequests = req.body.rateLimitServerRequests;
    }

    if ('rateLimitWindowSeconds' in req.body) {
      if (req.body.rateLimitWindowSeconds !== null && (!Number.isInteger(req.body.rateLimitWindowSeconds) || req.body.rateLimitWindowSeconds <= 0)) {
        res.status(400).json({ error: 'rateLimitWindowSeconds must be a positive integer or null.' });
        return;
      }
      patch.rateLimitWindowSeconds = req.body.rateLimitWindowSeconds;
    }

    if ('burstLimitRequests' in req.body) {
      if (req.body.burstLimitRequests !== null && (!Number.isInteger(req.body.burstLimitRequests) || req.body.burstLimitRequests <= 0)) {
        res.status(400).json({ error: 'burstLimitRequests must be a positive integer or null.' });
        return;
      }
      patch.burstLimitRequests = req.body.burstLimitRequests;
    }

    if ('burstWindowSeconds' in req.body) {
      if (req.body.burstWindowSeconds !== null && (!Number.isInteger(req.body.burstWindowSeconds) || req.body.burstWindowSeconds <= 0)) {
        res.status(400).json({ error: 'burstWindowSeconds must be a positive integer or null.' });
        return;
      }
      patch.burstWindowSeconds = req.body.burstWindowSeconds;
    }

    if ('dailyTokenBudget' in req.body) {
      if (req.body.dailyTokenBudget !== null && (!Number.isInteger(req.body.dailyTokenBudget) || req.body.dailyTokenBudget <= 0)) {
        res.status(400).json({ error: 'dailyTokenBudget must be a positive integer or null.' });
        return;
      }
      patch.dailyTokenBudget = req.body.dailyTokenBudget;
    }

    if ('monthlyTokenBudget' in req.body) {
      if (req.body.monthlyTokenBudget !== null && (!Number.isInteger(req.body.monthlyTokenBudget) || req.body.monthlyTokenBudget <= 0)) {
        res.status(400).json({ error: 'monthlyTokenBudget must be a positive integer or null.' });
        return;
      }
      patch.monthlyTokenBudget = req.body.monthlyTokenBudget;
    }

    if ('autoDisableOnBudgetExceeded' in req.body) {
      if (typeof req.body.autoDisableOnBudgetExceeded !== 'boolean') {
        res.status(400).json({ error: 'autoDisableOnBudgetExceeded must be a boolean.' });
        return;
      }
      patch.autoDisableOnBudgetExceeded = req.body.autoDisableOnBudgetExceeded;
    }

    if ('disabledReason' in req.body) {
      if (req.body.disabledReason !== null && typeof req.body.disabledReason !== 'string') {
        res.status(400).json({ error: 'disabledReason must be a string or null.' });
        return;
      }
      patch.disabledReason = req.body.disabledReason;
    }

    if ('temperature' in req.body) {
      if (req.body.temperature !== null && (typeof req.body.temperature !== 'number' || Number.isNaN(req.body.temperature))) {
        res.status(400).json({ error: 'temperature must be a number or null.' });
        return;
      }
      patch.temperature = req.body.temperature;
    }

    if ('allowDmInvocation' in req.body) {
      if (typeof req.body.allowDmInvocation !== 'boolean') {
        res.status(400).json({ error: 'allowDmInvocation must be a boolean.' });
        return;
      }
      patch.allowDmInvocation = req.body.allowDmInvocation;
    }

    if ('invocationPolicy' in req.body) {
      if (req.body.invocationPolicy !== 'everyone' && req.body.invocationPolicy !== 'roles') {
        res.status(400).json({ error: "invocationPolicy must be one of: 'everyone', 'roles'." });
        return;
      }
      patch.invocationPolicy = req.body.invocationPolicy;
    }

    try {
      const settings = await deps.updateServerAiSettings(req.params.serverId, auth.userId, patch);
      res.json({ settings: { ...settings, status: buildAiStatus(settings) } });
    } catch (error) {
      const status = resolveMembershipErrorStatus(error);
      if (status === 404) {
        res.status(404).json({ error: 'Server not found.' });
        return;
      }

      res.status(403).json({ error: 'Only server owners can update AI settings in this server.' });
    }
  });

  app.patch('/servers/:serverId/members/:userId/permissions', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const targetUserId = String(req.params.userId ?? '').trim();
    if (!targetUserId) {
      res.status(400).json({ error: 'userId is required.' });
      return;
    }

    if (typeof req.body?.canShareScreen !== 'boolean') {
      res.status(400).json({ error: 'canShareScreen must be a boolean.' });
      return;
    }

    try {
      await deps.updateMemberScreenSharePermission(
        req.params.serverId,
        targetUserId,
        req.body.canShareScreen,
        auth.userId,
      );
      await deps.writeModerationAuditLog({
        id: randomUUID(),
        serverId: req.params.serverId,
        actorUserId: auth.userId,
        targetUserId,
        action: 'member_permission_update',
        details: { canShareScreen: req.body.canShareScreen },
      });
      res.status(200).json({ ok: true });
    } catch (error) {
      const status = resolveMembershipErrorStatus(error);
      if (status === 404) {
        res.status(404).json({ error: 'Target member was not found in this server.' });
        return;
      }

      res.status(403).json({ error: 'Only server owners can update member permissions in this server.' });
    }
  });

  app.get('/servers/:serverId/audit-logs', async (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) {
      return;
    }

    const limit =
      req.query.limit === undefined ? undefined : parsePositiveInt(req.query.limit, maxSearchLimit);
    if (req.query.limit !== undefined && limit === null) {
      res.status(400).json({ error: `limit must be an integer between 1 and ${maxSearchLimit}.` });
      return;
    }

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
