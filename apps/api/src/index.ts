import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import type net from 'node:net';
import dotenv from 'dotenv';
import {
  type ChatMessage,
  type ClientEvent,
  type DmMessage,
  type CoWatchPlaybackState,
  type ServerEvent,
  type VoiceEffectMode,
  isValidClientEvent,
  parseScreenShareRolloutStage,
} from '@curly-broccoli/shared';
import { createApp } from './app.js';
import { requestChannelAiReply } from './ai/service.js';
import { isAiEnabledForServer, isAiGlobalKillSwitchEnabled } from './ai/rollout.js';
import { verifyAccessToken } from './auth.js';
import {
  addMemberByUsername,
  joinServerByName,
  addServerMembership,
  canAccessChannel,
  canManageScreenShare,
  canAccessDmThread,
  chatHistoryLimit,
  createChannel,
  createMessageAttachment,
  createOrGetDmThread,
  createServer,
  createUser,
  deleteMessageById,
  updateMessageById,
  fetchDmMessagesPage,
  fetchRecentDmMessages,
  fetchChannelMessagesPage,
  fetchRecentMessages,
  findRefreshToken,
  findUserById,
  findUserByUsername,
  getServerIdForChannel,
  getUnreadSummary,
  getChannelWatchSession,
  isMemberOfServer,
  isMutedInServer,
  listChannelsForServer,
  listDmThreadsForUser,
  listMessageAttachmentsByIds,
  listModerationAuditLogs,
  listServerMembers,
  listServersForUser,
  muteUserInServer,
  unmuteUserInServer,
  updateMemberScreenSharePermission,
  reportMessageById,
  markChannelAsRead,
  markDmThreadAsRead,
  revokeRefreshToken,
  runMigrations,
  saveDmMessage,
  saveMessage,
  searchChannelMessagesPage,
  searchDmMessagesPage,
  storeRefreshToken,
  upsertChannelWatchSession,
  writeModerationAuditLog,
  getServerAudioSettingsByChannel,
  getServerAiSettings,
  disableServerAiDueToBudget,
  getServerAiBudgetUsage,
  recordServerAiUsage,
  updateServerAudioSettings,
  updateServerAiSettings,
} from './db.js';

dotenv.config();

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const port = Number(process.env.API_PORT ?? 4000);
const app = createApp({
  fetchRecentMessages: fetchChannelMessagesPage,
  deleteMessageById,
  updateMessageById,
  reportMessageById,
  muteUserInServer,
  unmuteUserInServer,
  updateMemberScreenSharePermission,
  updateServerAudioSettings,
  getServerAiSettings,
  updateServerAiSettings,
  listModerationAuditLogs,
  writeModerationAuditLog,
  findUserByUsername,
  findUserById,
  createUser,
  storeRefreshToken,
  findRefreshToken,
  revokeRefreshToken,
  listServersForUser,
  createServer,
  addServerMembership,
  listChannelsForServer,
  createChannel,
  addMemberByUsername,
  joinServerByName,
  listServerMembers,
  createOrGetDmThread,
  listDmThreadsForUser,
  fetchRecentDmMessages: fetchDmMessagesPage,
  searchChannelMessages: searchChannelMessagesPage,
  searchDmMessages: searchDmMessagesPage,
  canAccessDmThread,
  canAccessChannel,
  createMessageAttachment,
  notifyMessageEdited: ({ channelId, messageId, text, editedAt }) => {
    broadcastToChannel(channelId, {
      type: 'chat:message-edited',
      payload: { channelId, messageId, text, editedAt },
    });
  },
  markChannelAsRead,
  markDmThreadAsRead,
  getUnreadSummary,
  notifyUnreadUpdated: ({ userId, summary }) => {
    sendToUserConnections(userId, {
      type: 'notification:unread-updated',
      payload: { summary },
    });
  },
  notifyServerInvite: ({ userId, serverId, serverName, invitedByUserId, invitedByUsername }) => {
    sendToUserConnections(userId, {
      type: 'notification:server-invite',
      payload: { serverId, serverName, invitedByUserId, invitedByUsername },
    });
  },
});
const server = http.createServer(app);

const RATE_LIMIT_WINDOW_MS = 4_000;
const RATE_LIMIT_MAX_MESSAGES = 6;
const SOUNDBOARD_RATE_LIMIT_WINDOW_MS = 5_000;
const SOUNDBOARD_RATE_LIMIT_MAX_EVENTS = 5;
const AI_INVOKE_COOLDOWN_MS = 2_500;
const DEFAULT_AI_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_AI_USER_REQUEST_LIMIT = 4;
const DEFAULT_AI_SERVER_REQUEST_LIMIT = 20;
const DEFAULT_AI_BURST_WINDOW_SECONDS = 10;
const DEFAULT_AI_BURST_LIMIT = 3;
const DEFAULT_AI_MAX_PROMPT_CHARS = 2_000;
const BLOCKED_AI_CONTENT_PATTERNS: Array<{ category: string; pattern: RegExp }> = [
  { category: 'self_harm', pattern: /(?:how\s+to\s+)?(?:self[-\s]?harm|suicide|kill\s+myself)/i },
  { category: 'extremism', pattern: /\b(build|make)\s+(?:a\s+)?(?:bomb|explosive)\b/i },
  { category: 'hate', pattern: /\b(?:racial\s+slur|genocide\s+support)\b/i },
];

const clients = new Set<net.Socket>();
const userByConnection = new Map<net.Socket, { userId: string; username: string }>();
const activeChannelByConnection = new Map<net.Socket, string>();

const activeDmThreadByConnection = new Map<net.Socket, string>();
const dmConnectionsByThread = new Map<string, Set<net.Socket>>();
const sentTimestampsByConnection = new Map<net.Socket, number[]>();
const soundboardTimestampsByConnection = new Map<net.Socket, number[]>();
const voiceEffectByConnection = new Map<net.Socket, VoiceEffectMode>();
const readBufferByConnection = new Map<net.Socket, Buffer>();
const serversByConnection = new Map<net.Socket, Set<string>>();
const connectionsByServer = new Map<string, Set<net.Socket>>();
const typingByChannel = new Map<
  string,
  Map<string, { username: string; connections: Set<net.Socket> }>
>();
const aiPendingByChannel = new Set<string>();
const aiLastInvokeByUserChannel = new Map<string, number>();
const aiRequestTimestampsByUserServer = new Map<string, number[]>();
const aiRequestTimestampsByServer = new Map<string, number[]>();
const aiBurstTimestampsByServer = new Map<string, number[]>();
const voiceConnectionsByChannel = new Map<string, Set<net.Socket>>();
const voiceChannelByConnection = new Map<net.Socket, string>();
const screenPresenterByChannel = new Map<string, string>();
const screenChannelByPresenterUserId = new Map<string, string>();
const screenViewersByChannel = new Map<string, Set<string>>();
const watchSessionByChannel = new Map<string, CoWatchPlaybackState>();

function computeWatchPosition(state: CoWatchPlaybackState, nowMs = Date.now()) {
  if (state.paused) {
    return state.positionSec;
  }

  const driftSec = Math.max(0, (nowMs - Date.parse(state.lastEventAt)) / 1000);
  return state.positionSec + driftSec;
}

async function hydrateWatchSession(channelId: string) {
  const cached = watchSessionByChannel.get(channelId);
  if (cached) {
    return cached;
  }

  const persisted = await getChannelWatchSession(channelId);
  if (persisted) {
    watchSessionByChannel.set(channelId, persisted);
  }

  return persisted;
}

function canControlWatchSession(state: CoWatchPlaybackState, userId: string) {
  return state.hostUserId === userId || state.controllers.includes(userId);
}

function broadcastWatchEvent(channelId: string, event: ServerEvent) {
  broadcastToChannel(channelId, event);
}


function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseAiInvocation(text: string, botDisplayName: string): string | null {
  const trimmedText = text.trim();
  if (!trimmedText) {
    return null;
  }

  const commandMatch = trimmedText.match(/^\/ask(?:\s+(.+))?$/i);
  if (commandMatch) {
    return commandMatch[1]?.trim() || null;
  }

  const escapedName = escapeRegExp(botDisplayName.trim());
  if (!escapedName) {
    return null;
  }

  const mentionPattern = new RegExp(`(?:^|\\s)@${escapedName}(?:\\b|\\s|$)`, 'i');
  if (!mentionPattern.test(trimmedText)) {
    return null;
  }

  const withoutMention = trimmedText.replace(mentionPattern, ' ').trim();
  return withoutMention.length > 0 ? withoutMention : null;
}




type AiGuardrailError = {
  code: 'ai_throttled' | 'ai_budget_exceeded' | 'ai_prompt_too_long' | 'ai_policy_blocked';
  message: string;
};

function trimRecentTimestamps(timestamps: number[], windowMs: number, now: number) {
  const threshold = now - windowMs;
  while (timestamps.length > 0 && timestamps[0] < threshold) {
    timestamps.shift();
  }
}

function checkPromptPolicy(prompt: string): { blocked: true; category: string } | { blocked: false } {
  for (const rule of BLOCKED_AI_CONTENT_PATTERNS) {
    if (rule.pattern.test(prompt)) {
      return { blocked: true, category: rule.category };
    }
  }

  return { blocked: false };
}

function guardAiRateLimits(input: {
  serverId: string;
  userId: string;
  settings: {
    rateLimitUserRequests: number | null;
    rateLimitServerRequests: number | null;
    rateLimitWindowSeconds: number | null;
    burstLimitRequests: number | null;
    burstWindowSeconds: number | null;
  };
}): AiGuardrailError | null {
  const now = Date.now();
  const windowMs = (input.settings.rateLimitWindowSeconds ?? DEFAULT_AI_RATE_LIMIT_WINDOW_SECONDS) * 1000;
  const burstWindowMs = (input.settings.burstWindowSeconds ?? DEFAULT_AI_BURST_WINDOW_SECONDS) * 1000;
  const userLimit = input.settings.rateLimitUserRequests ?? DEFAULT_AI_USER_REQUEST_LIMIT;
  const serverLimit = input.settings.rateLimitServerRequests ?? DEFAULT_AI_SERVER_REQUEST_LIMIT;
  const burstLimit = input.settings.burstLimitRequests ?? DEFAULT_AI_BURST_LIMIT;

  const userKey = `${input.serverId}:${input.userId}`;
  const userTimestamps = aiRequestTimestampsByUserServer.get(userKey) ?? [];
  trimRecentTimestamps(userTimestamps, windowMs, now);
  if (userTimestamps.length >= userLimit) {
    aiRequestTimestampsByUserServer.set(userKey, userTimestamps);
    return {
      code: 'ai_throttled',
      message: 'You are sending AI requests too quickly. Please wait a moment and try again.',
    };
  }

  const serverTimestamps = aiRequestTimestampsByServer.get(input.serverId) ?? [];
  trimRecentTimestamps(serverTimestamps, windowMs, now);
  if (serverTimestamps.length >= serverLimit) {
    aiRequestTimestampsByServer.set(input.serverId, serverTimestamps);
    return {
      code: 'ai_throttled',
      message: 'AI is currently busy for this server. Please try again shortly.',
    };
  }

  const burstTimestamps = aiBurstTimestampsByServer.get(input.serverId) ?? [];
  trimRecentTimestamps(burstTimestamps, burstWindowMs, now);
  if (burstTimestamps.length >= burstLimit) {
    aiBurstTimestampsByServer.set(input.serverId, burstTimestamps);
    return {
      code: 'ai_throttled',
      message: 'Too many AI requests in a short burst. Please slow down.',
    };
  }

  userTimestamps.push(now);
  serverTimestamps.push(now);
  burstTimestamps.push(now);
  aiRequestTimestampsByUserServer.set(userKey, userTimestamps);
  aiRequestTimestampsByServer.set(input.serverId, serverTimestamps);
  aiBurstTimestampsByServer.set(input.serverId, burstTimestamps);
  return null;
}

function parseCsvSet(raw: string | undefined) {
  if (!raw) {
    return new Set<string>();
  }

  return new Set(
    raw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

function isScreenShareEnabledForUser(channelId: string, username: string) {
  const stage = parseScreenShareRolloutStage(process.env.SCREEN_SHARE_ROLLOUT_STAGE);
  if (stage === 'disabled') {
    return false;
  }

  if (stage === 'full') {
    return true;
  }

  const internalUsers = parseCsvSet(process.env.SCREEN_SHARE_INTERNAL_USERNAMES);
  if (internalUsers.has(username)) {
    return true;
  }

  if (stage === 'internal') {
    return false;
  }

  const betaChannels = parseCsvSet(process.env.SCREEN_SHARE_BETA_CHANNEL_IDS);
  return betaChannels.has(channelId);
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

function broadcastToChannel(channelId: string, event: ServerEvent) {
  const frame = encodeFrame(JSON.stringify(event));
  for (const client of clients) {
    if (activeChannelByConnection.get(client) === channelId) {
      client.write(frame);
    }
  }
}

function broadcastToDmThread(threadId: string, event: ServerEvent) {
  const frame = encodeFrame(JSON.stringify(event));
  for (const socket of dmConnectionsByThread.get(threadId) ?? []) {
    socket.write(frame);
  }
}

function sendToUserConnections(userId: string, event: ServerEvent) {
  const frame = encodeFrame(JSON.stringify(event));
  for (const socket of clients) {
    if (userByConnection.get(socket)?.userId === userId) {
      socket.write(frame);
    }
  }
}

function broadcastToServer(serverId: string, event: ServerEvent) {
  const frame = encodeFrame(JSON.stringify(event));
  for (const socket of connectionsByServer.get(serverId) ?? []) {
    socket.write(frame);
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


function isSoundboardRateLimited(socket: net.Socket) {
  const now = Date.now();
  const timestamps = soundboardTimestampsByConnection.get(socket) ?? [];
  const recent = timestamps.filter((value) => now - value <= SOUNDBOARD_RATE_LIMIT_WINDOW_MS);

  if (recent.length >= SOUNDBOARD_RATE_LIMIT_MAX_EVENTS) {
    soundboardTimestampsByConnection.set(socket, recent);
    return true;
  }

  recent.push(now);
  soundboardTimestampsByConnection.set(socket, recent);
  return false;
}

function stopTypingForSocket(socket: net.Socket, channelId?: string) {
  const currentUser = userByConnection.get(socket);
  if (!currentUser) {
    return;
  }

  const channelsToCheck = channelId ? [channelId] : Array.from(typingByChannel.keys());

  for (const targetChannel of channelsToCheck) {
    const channelState = typingByChannel.get(targetChannel);
    if (!channelState) {
      continue;
    }

    const userState = channelState.get(currentUser.userId);
    if (!userState) {
      continue;
    }

    userState.connections.delete(socket);
    if (userState.connections.size === 0) {
      channelState.delete(currentUser.userId);
      broadcastToChannel(targetChannel, {
        type: 'typing:stop',
        payload: { channelId: targetChannel, userId: currentUser.userId },
      });
    }

    if (channelState.size === 0) {
      typingByChannel.delete(targetChannel);
    }
  }
}

function addPresenceSubscription(socket: net.Socket, serverId: string) {
  const joinedServers = serversByConnection.get(socket) ?? new Set<string>();
  if (joinedServers.has(serverId)) {
    return;
  }

  joinedServers.add(serverId);
  serversByConnection.set(socket, joinedServers);

  const sockets = connectionsByServer.get(serverId) ?? new Set<net.Socket>();
  const alreadyOnlineUserIds = new Set(
    Array.from(sockets)
      .map((client) => userByConnection.get(client)?.userId)
      .filter((id): id is string => Boolean(id)),
  );

  sockets.add(socket);
  connectionsByServer.set(serverId, sockets);

  sendEvent(socket, {
    type: 'presence:sync',
    payload: {
      serverId,
      onlineUserIds: Array.from(alreadyOnlineUserIds),
    },
  });

  const authUser = userByConnection.get(socket);
  if (authUser) {
    broadcastToServer(serverId, {
      type: 'presence:user-online',
      payload: { serverId, userId: authUser.userId },
    });
  }
}

function removePresenceSubscription(socket: net.Socket, serverId: string) {
  const joinedServers = serversByConnection.get(socket);
  joinedServers?.delete(serverId);

  const sockets = connectionsByServer.get(serverId);
  if (!sockets) {
    return;
  }

  sockets.delete(socket);
  if (sockets.size === 0) {
    connectionsByServer.delete(serverId);
  }

  const authUser = userByConnection.get(socket);
  if (!authUser) {
    return;
  }

  const stillOnline = Array.from(sockets).some(
    (client) => userByConnection.get(client)?.userId === authUser.userId,
  );

  if (!stillOnline) {
    broadcastToServer(serverId, {
      type: 'presence:user-offline',
      payload: { serverId, userId: authUser.userId },
    });
  }
}

function listVoiceParticipants(channelId: string) {
  const participantsByUserId = new Map<string, { userId: string; username: string; activeVoiceEffect: VoiceEffectMode }>();
  for (const socket of voiceConnectionsByChannel.get(channelId) ?? []) {
    const authUser = userByConnection.get(socket);
    if (!authUser) {
      continue;
    }

    participantsByUserId.set(authUser.userId, {
      userId: authUser.userId,
      username: authUser.username,
      activeVoiceEffect: voiceEffectByConnection.get(socket) ?? 'none',
    });
  }

  return Array.from(participantsByUserId.values());
}

async function emitScreenShareModerationAudit(params: {
  channelId: string;
  actorUserId: string;
  action: 'screen_share_start' | 'screen_share_stop' | 'screen_share_force_stop';
  targetUserId?: string;
}) {
  const server = await getServerIdForChannel(params.channelId);
  if (!server) {
    return;
  }

  await writeModerationAuditLog({
    id: randomUUID(),
    serverId: server.server_id,
    actorUserId: params.actorUserId,
    targetUserId: params.targetUserId ?? null,
    action: params.action,
    details: { channelId: params.channelId },
  });

  const event = encodeFrame(
    JSON.stringify({
      type: 'moderation:audit',
      payload: {
        channelId: params.channelId,
        action: params.action,
        actorUserId: params.actorUserId,
        targetUserId: params.targetUserId,
      },
    }),
  );

  for (const client of voiceConnectionsByChannel.get(params.channelId) ?? []) {
    client.write(event);
  }
}

function stopScreenShare(channelId: string, presenterUserId: string) {
  screenPresenterByChannel.delete(channelId);
  screenChannelByPresenterUserId.delete(presenterUserId);
  screenViewersByChannel.delete(channelId);

  const frame = encodeFrame(
    JSON.stringify({
      type: 'screen:share-stop',
      payload: { channelId, presenterUserId },
    }),
  );

  for (const client of voiceConnectionsByChannel.get(channelId) ?? []) {
    client.write(frame);
  }
}

function handleViewerLeave(channelId: string, userId: string) {
  const presenterUserId = screenPresenterByChannel.get(channelId);
  if (!presenterUserId) {
    return;
  }

  const viewers = screenViewersByChannel.get(channelId);
  if (!viewers || !viewers.delete(userId)) {
    return;
  }

  if (viewers.size === 0) {
    screenViewersByChannel.delete(channelId);
  }

  const frame = encodeFrame(
    JSON.stringify({
      type: 'screen:viewer-left',
      payload: { channelId, presenterUserId, userId },
    }),
  );

  for (const client of voiceConnectionsByChannel.get(channelId) ?? []) {
    client.write(frame);
  }
}

function leaveVoiceChannel(socket: net.Socket) {
  const channelId = voiceChannelByConnection.get(socket);
  if (!channelId) {
    return;
  }

  voiceChannelByConnection.delete(socket);
  const sockets = voiceConnectionsByChannel.get(channelId);
  sockets?.delete(socket);

  const authUser = userByConnection.get(socket);
  if (authUser) {
    if (screenPresenterByChannel.get(channelId) === authUser.userId) {
      stopScreenShare(channelId, authUser.userId);
    } else {
      handleViewerLeave(channelId, authUser.userId);
    }
  }

  if (sockets && sockets.size === 0) {
    voiceConnectionsByChannel.delete(channelId);
  }

  if (!authUser) {
    return;
  }

  const stillPresent = Array.from(sockets ?? []).some(
    (client) => userByConnection.get(client)?.userId === authUser.userId,
  );

  if (!stillPresent) {
    const remainingSockets = voiceConnectionsByChannel.get(channelId);
    const frame = encodeFrame(
      JSON.stringify({
        type: 'voice:user-left',
        payload: { channelId, userId: authUser.userId },
      }),
    );

    for (const client of remainingSockets ?? []) {
      client.write(frame);
    }
  }
}

function closeConnection(socket: net.Socket) {
  stopTypingForSocket(socket);
  leaveVoiceChannel(socket);

  const serverIds = Array.from(serversByConnection.get(socket) ?? []);
  for (const serverId of serverIds) {
    removePresenceSubscription(socket, serverId);
  }

  clients.delete(socket);
  userByConnection.delete(socket);
  activeChannelByConnection.delete(socket);
  const activeDmThreadId = activeDmThreadByConnection.get(socket);
  if (activeDmThreadId) {
    const sockets = dmConnectionsByThread.get(activeDmThreadId);
    sockets?.delete(socket);
    if (sockets && sockets.size === 0) {
      dmConnectionsByThread.delete(activeDmThreadId);
    }
  }
  activeDmThreadByConnection.delete(socket);
  sentTimestampsByConnection.delete(socket);
  soundboardTimestampsByConnection.delete(socket);
  voiceEffectByConnection.delete(socket);
  readBufferByConnection.delete(socket);
  serversByConnection.delete(socket);
}

async function handleJoinChannel(socket: net.Socket, channelId: string) {
  const authUser = userByConnection.get(socket);
  if (!authUser) {
    sendEvent(socket, { type: 'error', payload: { message: 'Unauthorized connection.' } });
    return;
  }

  const allowed = await canAccessChannel(channelId, authUser.userId);
  if (!allowed) {
    sendEvent(socket, { type: 'error', payload: { message: 'You cannot join this channel.' } });
    return;
  }

  const previousChannelId = activeChannelByConnection.get(socket);
  activeChannelByConnection.set(socket, channelId);
  if (previousChannelId && previousChannelId !== channelId) {
    stopTypingForSocket(socket, previousChannelId);
  }
  sendEvent(socket, { type: 'chat:joined-channel', payload: { channelId } });

  try {
    const messages = await fetchRecentMessages(channelId, chatHistoryLimit);
    sendEvent(socket, { type: 'chat:history', payload: { channelId, messages } });
    const watchState = await hydrateWatchSession(channelId);
    sendEvent(socket, { type: 'watch:state', payload: { channelId, state: watchState ?? null } });
  } catch {
    sendEvent(socket, {
      type: 'error',
      payload: { message: 'Unable to load message history.' },
    });
  }
}

async function handleJoinDmThread(socket: net.Socket, threadId: string) {
  const authUser = userByConnection.get(socket);
  if (!authUser) {
    sendEvent(socket, { type: 'error', payload: { message: 'Unauthorized connection.' } });
    return;
  }

  const allowed = await canAccessDmThread(threadId, authUser.userId);
  if (!allowed) {
    sendEvent(socket, { type: 'error', payload: { message: 'You cannot join this DM thread.' } });
    return;
  }

  const previousThreadId = activeDmThreadByConnection.get(socket);
  if (previousThreadId && previousThreadId !== threadId) {
    const previousSockets = dmConnectionsByThread.get(previousThreadId);
    previousSockets?.delete(socket);
    if (previousSockets && previousSockets.size === 0) {
      dmConnectionsByThread.delete(previousThreadId);
    }
  }

  activeDmThreadByConnection.set(socket, threadId);
  const sockets = dmConnectionsByThread.get(threadId) ?? new Set<net.Socket>();
  sockets.add(socket);
  dmConnectionsByThread.set(threadId, sockets);

  sendEvent(socket, { type: 'dm:joined-thread', payload: { threadId } });

  try {
    const messages = await fetchRecentDmMessages(threadId, chatHistoryLimit);
    sendEvent(socket, { type: 'dm:history', payload: { threadId, messages } });
  } catch {
    sendEvent(socket, {
      type: 'error',
      payload: { message: 'Unable to load DM history.' },
    });
  }
}

async function handleClientEvent(socket: net.Socket, raw: string) {
  let event: ClientEvent;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isValidClientEvent(parsed)) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'Invalid event payload.' },
      });
      return;
    }

    event = parsed as ClientEvent;
  } catch {
    sendEvent(socket, {
      type: 'error',
      payload: { message: 'Invalid JSON event.' },
    });
    return;
  }

  if (event.type === 'ping') {
    sendEvent(socket, { type: 'pong', payload: {} });
    return;
  }

  if (event.type === 'presence:join-server') {
    const currentUser = userByConnection.get(socket);
    const serverId = event.payload?.serverId?.trim();
    if (!currentUser || !serverId) {
      sendEvent(socket, { type: 'error', payload: { message: 'serverId is required.' } });
      return;
    }

    const allowed = await isMemberOfServer(serverId, currentUser.userId);
    if (!allowed) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'You cannot join this server presence.' },
      });
      return;
    }

    addPresenceSubscription(socket, serverId);
    return;
  }

  if (event.type === 'voice:join-channel') {
    const currentUser = userByConnection.get(socket);
    const channelId = event.payload?.channelId?.trim();
    if (!currentUser || !channelId) {
      sendEvent(socket, { type: 'error', payload: { message: 'channelId is required.' } });
      return;
    }

    const allowed = await canAccessChannel(channelId, currentUser.userId);
    if (!allowed) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'You cannot join this voice channel.' },
      });
      return;
    }

    const previousChannelId = voiceChannelByConnection.get(socket);
    if (previousChannelId === channelId) {
      sendEvent(socket, {
        type: 'voice:participants',
        payload: { channelId, participants: listVoiceParticipants(channelId) },
      });
      return;
    }

    leaveVoiceChannel(socket);
    voiceChannelByConnection.set(socket, channelId);
    voiceEffectByConnection.set(socket, voiceEffectByConnection.get(socket) ?? 'none');
    const sockets = voiceConnectionsByChannel.get(channelId) ?? new Set<net.Socket>();
    sockets.add(socket);
    voiceConnectionsByChannel.set(channelId, sockets);

    console.info('[voice] join', { channelId, userId: currentUser.userId });

    sendEvent(socket, {
      type: 'voice:participants',
      payload: { channelId, participants: listVoiceParticipants(channelId) },
    });

    const presenterUserId = screenPresenterByChannel.get(channelId);
    if (presenterUserId) {
      const presenter = listVoiceParticipants(channelId).find(
        (participant) => participant.userId === presenterUserId,
      );
      if (presenter) {
        sendEvent(socket, {
          type: 'screen:share-start',
          payload: { channelId, presenter },
        });
      }
    }

    const frame = encodeFrame(
      JSON.stringify({
        type: 'voice:user-joined',
        payload: {
          channelId,
          participant: { userId: currentUser.userId, username: currentUser.username },
        },
      }),
    );
    for (const client of sockets) {
      if (client === socket) {
        continue;
      }
      client.write(frame);
    }

    const activePresenterUserId = screenPresenterByChannel.get(channelId);
    if (activePresenterUserId && activePresenterUserId !== currentUser.userId) {
      const viewers = screenViewersByChannel.get(channelId) ?? new Set<string>();
      viewers.add(currentUser.userId);
      screenViewersByChannel.set(channelId, viewers);

      const viewerFrame = encodeFrame(
        JSON.stringify({
          type: 'screen:viewer-joined',
          payload: {
            channelId,
            presenterUserId: activePresenterUserId,
            viewer: { userId: currentUser.userId, username: currentUser.username },
          },
        }),
      );

      for (const client of sockets) {
        client.write(viewerFrame);
      }
    }

    return;
  }

  if (event.type === 'voice:leave-channel') {
    const channelId = voiceChannelByConnection.get(socket);
    const currentUser = userByConnection.get(socket);
    if (channelId && currentUser) {
      console.info('[voice] leave', { channelId, userId: currentUser.userId });
    }
    leaveVoiceChannel(socket);
    return;
  }

  if (event.type === 'voice:signal') {
    const currentUser = userByConnection.get(socket);
    const channelId = event.payload?.channelId?.trim();
    const targetUserId = event.payload?.targetUserId?.trim();
    if (!currentUser || !channelId || !targetUserId) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'channelId and targetUserId are required for signaling.' },
      });
      return;
    }

    if (voiceChannelByConnection.get(socket) !== channelId) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'Join the voice channel before sending signals.' },
      });
      return;
    }

    const targetSocket = Array.from(voiceConnectionsByChannel.get(channelId) ?? []).find(
      (client) => userByConnection.get(client)?.userId === targetUserId,
    );

    if (!targetSocket) {
      console.warn('[voice] signal_failure_peer_offline', { channelId, targetUserId });
      sendEvent(socket, { type: 'error', payload: { message: 'Voice peer is offline.' } });
      return;
    }

    sendEvent(targetSocket, {
      type: 'voice:signal',
      payload: {
        channelId,
        fromUserId: currentUser.userId,
        description: event.payload.description,
        iceRestart: event.payload.iceRestart,
        candidate: event.payload.candidate,
      },
    });
    return;
  }

  if (event.type === 'screen:share-start') {
    const currentUser = userByConnection.get(socket);
    const channelId = event.payload?.channelId?.trim();
    if (!currentUser || !channelId) {
      sendEvent(socket, { type: 'error', payload: { message: 'channelId is required.' } });
      return;
    }

    if (voiceChannelByConnection.get(socket) !== channelId) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'Join the voice channel before sharing your screen.' },
      });
      return;
    }

    if (!isScreenShareEnabledForUser(channelId, currentUser.username)) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'Screen sharing is not enabled for this rollout stage.' },
      });
      return;
    }

    const permissions = await canManageScreenShare(channelId, currentUser.userId);
    if (!permissions.canShare) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'You do not have permission to share your screen in this server.' },
      });
      return;
    }

    const existingPresenter = screenPresenterByChannel.get(channelId);
    if (existingPresenter && existingPresenter !== currentUser.userId) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'Someone is already sharing their screen in this channel.' },
      });
      return;
    }

    screenPresenterByChannel.set(channelId, currentUser.userId);
    screenChannelByPresenterUserId.set(currentUser.userId, channelId);
    screenViewersByChannel.set(
      channelId,
      new Set(listVoiceParticipants(channelId).map((participant) => participant.userId)),
    );

    const frame = encodeFrame(
      JSON.stringify({
        type: 'screen:share-start',
        payload: {
          channelId,
          presenter: { userId: currentUser.userId, username: currentUser.username },
        },
      }),
    );

    for (const client of voiceConnectionsByChannel.get(channelId) ?? []) {
      client.write(frame);
    }

    await emitScreenShareModerationAudit({
      channelId,
      actorUserId: currentUser.userId,
      action: 'screen_share_start',
      targetUserId: currentUser.userId,
    });
    return;
  }

  if (event.type === 'screen:share-stop') {
    const currentUser = userByConnection.get(socket);
    const channelId = event.payload?.channelId?.trim();
    if (!currentUser || !channelId) {
      sendEvent(socket, { type: 'error', payload: { message: 'channelId is required.' } });
      return;
    }

    if (screenPresenterByChannel.get(channelId) !== currentUser.userId) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'Only the current presenter can stop screen sharing.' },
      });
      return;
    }

    stopScreenShare(channelId, currentUser.userId);
    await emitScreenShareModerationAudit({
      channelId,
      actorUserId: currentUser.userId,
      action: 'screen_share_stop',
      targetUserId: currentUser.userId,
    });
    return;
  }

  if (event.type === 'screen:force-stop') {
    const currentUser = userByConnection.get(socket);
    const channelId = event.payload?.channelId?.trim();
    const presenterUserId = event.payload?.presenterUserId?.trim();
    if (!currentUser || !channelId || !presenterUserId) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'channelId and presenterUserId are required.' },
      });
      return;
    }

    const permissions = await canManageScreenShare(channelId, currentUser.userId);
    if (!permissions.canModerate) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'Only server owners can force stop screen sharing.' },
      });
      return;
    }

    if (screenPresenterByChannel.get(channelId) !== presenterUserId) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'That user is not the active screen presenter in this channel.' },
      });
      return;
    }

    stopScreenShare(channelId, presenterUserId);
    await emitScreenShareModerationAudit({
      channelId,
      actorUserId: currentUser.userId,
      action: 'screen_share_force_stop',
      targetUserId: presenterUserId,
    });
    return;
  }

  if (event.type === 'screen:signal') {
    const currentUser = userByConnection.get(socket);
    const channelId = event.payload?.channelId?.trim();
    const targetUserId = event.payload?.targetUserId?.trim();
    if (!currentUser || !channelId || !targetUserId) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'channelId and targetUserId are required for signaling.' },
      });
      return;
    }

    if (voiceChannelByConnection.get(socket) !== channelId) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'Join the voice channel before sending screen signals.' },
      });
      return;
    }

    const targetSocket = Array.from(voiceConnectionsByChannel.get(channelId) ?? []).find(
      (client) => userByConnection.get(client)?.userId === targetUserId,
    );

    if (!targetSocket) {
      sendEvent(socket, { type: 'error', payload: { message: 'Screen peer is offline.' } });
      return;
    }

    const presenterUserId = screenPresenterByChannel.get(channelId);
    if (!presenterUserId) {
      sendEvent(socket, { type: 'error', payload: { message: 'No active screen share.' } });
      return;
    }

    const isPresenter = presenterUserId === currentUser.userId;
    const isViewerToPresenter = targetUserId === presenterUserId;
    if (!isPresenter && !isViewerToPresenter) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'Screen signaling is only allowed between presenter and viewers.' },
      });
      return;
    }

    sendEvent(targetSocket, {
      type: 'screen:signal',
      payload: {
        channelId,
        fromUserId: currentUser.userId,
        streamType: event.payload.streamType,
        description: event.payload.description,
        candidate: event.payload.candidate,
      },
    });
    return;
  }

  if (
    event.type === 'watch:start' ||
    event.type === 'watch:pause' ||
    event.type === 'watch:seek' ||
    event.type === 'watch:state' ||
    event.type === 'watch:transfer-host' ||
    event.type === 'watch:set-permissions'
  ) {
    const currentUser = userByConnection.get(socket);
    const channelId = event.payload?.channelId?.trim();
    if (!currentUser || !channelId) {
      sendEvent(socket, { type: 'error', payload: { message: 'channelId is required.' } });
      return;
    }

    if (activeChannelByConnection.get(socket) !== channelId) {
      sendEvent(socket, { type: 'error', payload: { message: 'Join the channel before co-watching.' } });
      return;
    }

    const allowed = await canAccessChannel(channelId, currentUser.userId);
    if (!allowed) {
      sendEvent(socket, { type: 'error', payload: { message: 'You cannot access this channel.' } });
      return;
    }

    const existingState = await hydrateWatchSession(channelId);

    if (event.type === 'watch:state') {
      sendEvent(socket, { type: 'watch:state', payload: { channelId, state: existingState ?? null } });
      return;
    }

    if (event.type === 'watch:start') {
      const nextState: CoWatchPlaybackState = {
        media: event.payload.media,
        paused: event.payload.paused ?? true,
        positionSec: Math.max(0, event.payload.positionSec ?? 0),
        lastEventAt: event.payload.eventAt ?? new Date().toISOString(),
        hostUserId: existingState?.hostUserId ?? currentUser.userId,
        controllers: existingState?.controllers ?? [],
      };

      if (existingState && !canControlWatchSession(existingState, currentUser.userId)) {
        sendEvent(socket, { type: 'error', payload: { message: 'Only host/controllers can start media.' } });
        return;
      }

      watchSessionByChannel.set(channelId, nextState);
      await upsertChannelWatchSession(channelId, nextState);
      broadcastWatchEvent(channelId, { type: 'watch:start', payload: { channelId, state: nextState } });
      return;
    }

    if (!existingState) {
      sendEvent(socket, { type: 'error', payload: { message: 'No active co-watch session for channel.' } });
      return;
    }

    if (event.type === 'watch:transfer-host') {
      if (existingState.hostUserId !== currentUser.userId) {
        sendEvent(socket, { type: 'error', payload: { message: 'Only host can transfer host role.' } });
        return;
      }

      const nextState: CoWatchPlaybackState = { ...existingState, hostUserId: event.payload.targetUserId.trim() };
      watchSessionByChannel.set(channelId, nextState);
      await upsertChannelWatchSession(channelId, nextState);
      broadcastWatchEvent(channelId, { type: 'watch:state', payload: { channelId, state: nextState } });
      return;
    }

    if (event.type === 'watch:set-permissions') {
      if (existingState.hostUserId !== currentUser.userId) {
        sendEvent(socket, { type: 'error', payload: { message: 'Only host can set controller permissions.' } });
        return;
      }

      const nextState: CoWatchPlaybackState = { ...existingState, controllers: Array.from(new Set(event.payload.controllers)) };
      watchSessionByChannel.set(channelId, nextState);
      await upsertChannelWatchSession(channelId, nextState);
      broadcastWatchEvent(channelId, { type: 'watch:state', payload: { channelId, state: nextState } });
      return;
    }

    if (!canControlWatchSession(existingState, currentUser.userId)) {
      sendEvent(socket, { type: 'error', payload: { message: 'Only host/controllers can control playback.' } });
      return;
    }

    const nextState: CoWatchPlaybackState = {
      ...existingState,
      paused: event.payload.paused,
      positionSec:
        event.type === 'watch:pause'
          ? Math.max(0, event.payload.positionSec)
          : Math.max(0, event.payload.positionSec),
      lastEventAt: event.payload.eventAt ?? new Date().toISOString(),
    };

    watchSessionByChannel.set(channelId, nextState);
    await upsertChannelWatchSession(channelId, nextState);
    broadcastWatchEvent(channelId, {
      type: event.type,
      payload: {
        channelId,
        state: { ...nextState, positionSec: computeWatchPosition(nextState) },
      },
    });
    return;
  }



  if (event.type === 'soundboard:trigger') {
    const currentUser = userByConnection.get(socket);
    const channelId = event.payload?.channelId?.trim();
    const clipId = event.payload?.clipId?.trim();
    if (!currentUser || !channelId || !clipId) {
      sendEvent(socket, { type: 'error', payload: { message: 'channelId and clipId are required.' } });
      return;
    }

    if (voiceChannelByConnection.get(socket) !== channelId) {
      sendEvent(socket, { type: 'error', payload: { message: 'Join voice before triggering soundboard clips.' } });
      return;
    }

    if (isSoundboardRateLimited(socket)) {
      sendEvent(socket, { type: 'error', payload: { message: 'Soundboard rate limit exceeded. Slow down.' } });
      return;
    }

    const audioSettings = await getServerAudioSettingsByChannel(channelId);
    if (!audioSettings?.soundboardEnabled) {
      sendEvent(socket, { type: 'error', payload: { message: 'Soundboard is disabled by the server owner.' } });
      return;
    }

    broadcastToChannel(channelId, {
      type: 'soundboard:trigger',
      payload: { channelId, userId: currentUser.userId, username: currentUser.username, clipId },
    });
    return;
  }

  if (event.type === 'voice:effect-state') {
    const currentUser = userByConnection.get(socket);
    const channelId = event.payload?.channelId?.trim();
    const effect = event.payload?.effect;
    if (!currentUser || !channelId || !effect) {
      sendEvent(socket, { type: 'error', payload: { message: 'channelId and effect are required.' } });
      return;
    }

    if (voiceChannelByConnection.get(socket) !== channelId) {
      sendEvent(socket, { type: 'error', payload: { message: 'Join voice before updating effects.' } });
      return;
    }

    const audioSettings = await getServerAudioSettingsByChannel(channelId);
    if (!audioSettings?.voiceEffectsEnabled && effect !== 'none') {
      sendEvent(socket, { type: 'error', payload: { message: 'Voice effects are disabled by the server owner.' } });
      return;
    }

    voiceEffectByConnection.set(socket, effect);
    broadcastToChannel(channelId, {
      type: 'voice:effect-state',
      payload: { channelId, userId: currentUser.userId, effect },
    });
    return;
  }

  if (event.type === 'typing:start' || event.type === 'typing:stop') {
    const currentUser = userByConnection.get(socket);
    const channelId = event.payload?.channelId?.trim();
    if (!currentUser || !channelId) {
      sendEvent(socket, { type: 'error', payload: { message: 'channelId is required.' } });
      return;
    }

    if (activeChannelByConnection.get(socket) !== channelId) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'Join the channel before sending typing indicators.' },
      });
      return;
    }

    const channelState = typingByChannel.get(channelId) ?? new Map();
    const userState = channelState.get(currentUser.userId) ?? {
      username: currentUser.username,
      connections: new Set<net.Socket>(),
    };

    if (event.type === 'typing:start') {
      const wasTyping = userState.connections.size > 0;
      userState.connections.add(socket);
      channelState.set(currentUser.userId, userState);
      typingByChannel.set(channelId, channelState);

      if (!wasTyping) {
        broadcastToChannel(channelId, {
          type: 'typing:start',
          payload: {
            channelId,
            userId: currentUser.userId,
            username: currentUser.username,
          },
        });
      }
    } else {
      userState.connections.delete(socket);
      if (userState.connections.size === 0) {
        channelState.delete(currentUser.userId);
        broadcastToChannel(channelId, {
          type: 'typing:stop',
          payload: {
            channelId,
            userId: currentUser.userId,
          },
        });
      } else {
        channelState.set(currentUser.userId, userState);
      }

      if (channelState.size === 0) {
        typingByChannel.delete(channelId);
      } else {
        typingByChannel.set(channelId, channelState);
      }
    }

    return;
  }

  if (event.type === 'chat:join-channel') {
    const channelId = event.payload?.channelId?.trim();
    if (!channelId) {
      sendEvent(socket, { type: 'error', payload: { message: 'channelId is required.' } });
      return;
    }

    await handleJoinChannel(socket, channelId);
    return;
  }

  if (event.type === 'dm:join-thread') {
    const threadId = event.payload?.threadId?.trim();
    if (!threadId) {
      sendEvent(socket, { type: 'error', payload: { message: 'threadId is required.' } });
      return;
    }

    await handleJoinDmThread(socket, threadId);
    return;
  }

  if (event.type === 'dm:send') {
    const text = event.payload?.text?.trim();
    if (!text) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'Message cannot be empty.' },
      });
      return;
    }

    if (isRateLimited(socket)) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'Rate limit exceeded. Slow down a bit.' },
      });
      return;
    }

    const threadId = activeDmThreadByConnection.get(socket);
    if (!threadId) {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'Join a DM thread before sending messages.' },
      });
      return;
    }

    const currentUser = userByConnection.get(socket);
    const messageToSave: DmMessage = {
      id: randomUUID(),
      threadId,
      senderUserId: currentUser?.userId ?? '',
      senderUsername: currentUser?.username ?? 'Anonymous',
      text,
      createdAt: new Date().toISOString(),
    };

    try {
      const message = await saveDmMessage(messageToSave);
      broadcastToDmThread(threadId, {
        type: 'dm:message',
        payload: { message },
      });

      const thread = await listDmThreadsForUser(currentUser?.userId ?? '');
      const recipient = thread.find((item) => item.id === threadId);
      if (recipient) {
        sendToUserConnections(recipient.otherUserId, {
          type: 'notification:dm-message',
          payload: {
            threadId,
            messageId: message.id,
            senderUserId: message.senderUserId,
            senderUsername: message.senderUsername,
            text: message.text,
          },
        });
      }
    } catch {
      sendEvent(socket, {
        type: 'error',
        payload: { message: 'Unable to save your DM right now.' },
      });
    }

    return;
  }

  if (event.type !== 'chat:send') {
    sendEvent(socket, {
      type: 'error',
      payload: { message: 'Unsupported event type.' },
    });
    return;
  }

  const text = event.payload?.text?.trim() ?? '';
  const attachmentIds = Array.from(new Set(event.payload?.attachmentIds ?? [])).filter(Boolean);

  if (!text && attachmentIds.length === 0) {
    sendEvent(socket, {
      type: 'error',
      payload: { message: 'Message must include text or an image.' },
    });
    return;
  }

  if (isRateLimited(socket)) {
    sendEvent(socket, {
      type: 'error',
      payload: { message: 'Rate limit exceeded. Slow down a bit.' },
    });
    return;
  }

  const activeChannelId = activeChannelByConnection.get(socket);
  if (!activeChannelId) {
    sendEvent(socket, {
      type: 'error',
      payload: { message: 'Join a channel before sending messages.' },
    });
    return;
  }

  const currentUser = userByConnection.get(socket);

  if (!currentUser) {
    sendEvent(socket, { type: 'error', payload: { message: 'Unauthorized connection.' } });
    return;
  }

  const server = await getServerIdForChannel(activeChannelId);
  if (!server) {
    sendEvent(socket, { type: 'error', payload: { message: 'Channel not found.' } });
    return;
  }

  const muted = await isMutedInServer(server.server_id, currentUser.userId);
  if (muted) {
    sendEvent(socket, { type: 'error', payload: { message: 'You are muted in this server.' } });
    return;
  }

  const messageToSave: ChatMessage = {
    id: randomUUID(),
    channelId: activeChannelId,
    userId: currentUser.userId,
    user: currentUser.username,
    text,
    attachments: [],
    createdAt: new Date().toISOString(),
  };

  try {
    if (attachmentIds.length > 0) {
      const attachments = await listMessageAttachmentsByIds(attachmentIds, currentUser.userId);
      if (attachments.length !== attachmentIds.length) {
        sendEvent(socket, {
          type: 'error',
          payload: { message: 'Some attachments are invalid or unavailable.' },
        });
        return;
      }
    }

    const message = await saveMessage({
      ...messageToSave,
      attachmentIds,
    });
    stopTypingForSocket(socket, activeChannelId);
    broadcastToChannel(activeChannelId, {
      type: 'chat:message',
      payload: { message },
    });

    const aiSettings = await getServerAiSettings(server.server_id);
    const botDisplayName = aiSettings?.botDisplayName?.trim() || 'assistant';
    const prompt = parseAiInvocation(text, botDisplayName);

    if (
      prompt &&
      aiSettings?.enabled &&
      !aiPendingByChannel.has(activeChannelId) &&
      currentUser.username.toLowerCase() !== botDisplayName.toLowerCase()
    ) {
      if (!isAiEnabledForServer(server.server_id)) {
        broadcastToChannel(activeChannelId, {
          type: 'ai:reply-error',
          payload: {
            channelId: activeChannelId,
            requestId: randomUUID(),
            message: 'AI is currently disabled for this server rollout stage.',
          },
        });
        return;
      }
      if (aiSettings.disabledReason) {
        broadcastToChannel(activeChannelId, {
          type: 'ai:reply-error',
          payload: {
            channelId: activeChannelId,
            requestId: randomUUID(),
            message: `AI is disabled for this server: ${aiSettings.disabledReason}`,
          },
        });
      } else {
        const channelAllowed = await canAccessChannel(activeChannelId, currentUser.userId);
        const rateLimitKey = `${currentUser.userId}:${activeChannelId}`;
        const now = Date.now();
        const lastInvocationAt = aiLastInvokeByUserChannel.get(rateLimitKey) ?? 0;

        const promptLimit = aiSettings.maxPromptChars ?? DEFAULT_AI_MAX_PROMPT_CHARS;
        const overPromptLimit = prompt.length > promptLimit;
        const policy = checkPromptPolicy(prompt);
        const throttleError = guardAiRateLimits({
          serverId: server.server_id,
          userId: currentUser.userId,
          settings: aiSettings,
        });

        let budgetError: AiGuardrailError | null = null;
        if (!throttleError && aiSettings.enabled && (aiSettings.dailyTokenBudget || aiSettings.monthlyTokenBudget)) {
          const usage = await getServerAiBudgetUsage(server.server_id);
          if (aiSettings.dailyTokenBudget && usage.dailyTokensUsed >= aiSettings.dailyTokenBudget) {
            budgetError = {
              code: 'ai_budget_exceeded',
              message: 'AI is temporarily unavailable: this server reached its daily token budget.',
            };
          } else if (aiSettings.monthlyTokenBudget && usage.monthlyTokensUsed >= aiSettings.monthlyTokenBudget) {
            budgetError = {
              code: 'ai_budget_exceeded',
              message: 'AI is temporarily unavailable: this server reached its monthly token budget.',
            };
          }

          if (budgetError && aiSettings.autoDisableOnBudgetExceeded) {
            await disableServerAiDueToBudget(server.server_id, budgetError.message);
          }
        }

        let guardrailError: AiGuardrailError | null = null;
        if (overPromptLimit) {
          guardrailError = {
            code: 'ai_prompt_too_long',
            message: `Your AI prompt is too long. Please keep it under ${promptLimit} characters.`,
          };
        } else if (policy.blocked) {
          guardrailError = {
            code: 'ai_policy_blocked',
            message: `Your request was blocked by policy checks (${policy.category}). Please rephrase your question.`,
          };
        } else if (throttleError) {
          guardrailError = throttleError;
        } else if (budgetError) {
          guardrailError = budgetError;
        }

        if (guardrailError) {
          broadcastToChannel(activeChannelId, {
            type: 'ai:reply-error',
            payload: {
              channelId: activeChannelId,
              requestId: randomUUID(),
              message: guardrailError.message,
            },
          });
        } else if (channelAllowed && now - lastInvocationAt >= AI_INVOKE_COOLDOWN_MS) {
          aiLastInvokeByUserChannel.set(rateLimitKey, now);
          aiPendingByChannel.add(activeChannelId);

          const requestId = randomUUID();
          broadcastToChannel(activeChannelId, {
            type: 'chat:bot-pending',
            payload: {
              channelId: activeChannelId,
              requestId,
              requestedByUserId: currentUser.userId,
              botDisplayName,
            },
          });

          void (async () => {
            const startedAt = Date.now();
            try {
              let hasStreamedChunks = false;

              broadcastToChannel(activeChannelId, {
                type: 'ai:reply-start',
                payload: {
                  channelId: activeChannelId,
                  requestId,
                  requestedByUserId: currentUser.userId,
                  botDisplayName,
                },
              });

              const aiResult = await requestChannelAiReply(
                {
                  requestId,
                  serverId: server.server_id,
                  channelId: activeChannelId,
                  requesterUserId: currentUser.userId,
                  requesterUsername: currentUser.username,
                  botDisplayName,
                  question: prompt,
                  recentMessages: await fetchRecentMessages(activeChannelId, 20),
                  model: aiSettings.model,
                  systemPrompt: aiSettings.systemPrompt,
                  maxTokensPerReply: aiSettings.maxTokensPerReply,
                  maxCompletionTokens: aiSettings.maxCompletionTokens,
                  temperature: aiSettings.temperature,
                },
                {
                  onChunk: (chunk) => {
                    hasStreamedChunks = true;
                    broadcastToChannel(activeChannelId, {
                      type: 'ai:reply-chunk',
                      payload: {
                        channelId: activeChannelId,
                        requestId,
                        chunk,
                      },
                    });
                  },
                },
              );

              if (!aiResult.ok || !aiResult.value.outputText.trim()) {
                await recordServerAiUsage({
                  serverId: server.server_id,
                  requestCount: 1,
                  failureCount: 1,
                  latencyMs: Date.now() - startedAt,
                });
                broadcastToChannel(activeChannelId, {
                  type: 'ai:reply-error',
                  payload: {
                    channelId: activeChannelId,
                    requestId,
                    message: aiResult.ok ? 'AI produced an empty reply.' : aiResult.error.message,
                  },
                });
                return;
              }

              const botMessage = await saveMessage({
                id: randomUUID(),
                channelId: activeChannelId,
                userId: null,
                user: botDisplayName,
                text: aiResult.value.outputText.trim(),
                createdAt: new Date().toISOString(),
                attachmentIds: [],
              });

              await recordServerAiUsage({
                serverId: server.server_id,
                requestCount: 1,
                inputTokens: aiResult.value.usage.inputTokens,
                outputTokens: aiResult.value.usage.outputTokens,
                totalTokens: aiResult.value.usage.totalTokens,
                latencyMs: Date.now() - startedAt,
              });

              if (!hasStreamedChunks) {
                broadcastToChannel(activeChannelId, {
                  type: 'ai:reply-chunk',
                  payload: {
                    channelId: activeChannelId,
                    requestId,
                    chunk: botMessage.text,
                  },
                });
              }

              broadcastToChannel(activeChannelId, {
                type: 'ai:reply-complete',
                payload: {
                  channelId: activeChannelId,
                  requestId,
                  message: botMessage,
                },
              });

              broadcastToChannel(activeChannelId, {
                type: 'chat:message',
                payload: { message: botMessage },
              });
            } catch (error) {
              await recordServerAiUsage({
                serverId: server.server_id,
                requestCount: 1,
                failureCount: 1,
                latencyMs: Date.now() - startedAt,
              });
              console.error('Failed to process AI channel invocation.', error);
            } finally {
              aiPendingByChannel.delete(activeChannelId);
            }
          })();
        }
      }
    }


    try {
      const members = await listServerMembers(server.server_id, currentUser.userId);
      for (const member of members) {
        if (member.userId === currentUser.userId) {
          continue;
        }

        sendToUserConnections(member.userId, {
          type: 'notification:channel-message',
          payload: {
            serverId: server.server_id,
            channelId: activeChannelId,
            messageId: message.id,
            senderUserId: currentUser.userId,
            senderUsername: currentUser.username,
            text: message.text,
          },
        });
      }
    } catch {
      // Message is already persisted and broadcasted; skip notification fanout failures.
    }
  } catch {
    sendEvent(socket, {
      type: 'error',
      payload: { message: 'Unable to save your message right now.' },
    });
  }
}

server.on('upgrade', (req, socket: net.Socket) => {
  const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const token = requestUrl.searchParams.get('token');

  if (requestUrl.pathname !== '/' || !token) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  let authUser: { userId: string; username: string };
  try {
    authUser = verifyAccessToken(token);
  } catch {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key || Array.isArray(key)) {
    socket.destroy();
    return;
  }

  const accept = createHash('sha1')
    .update(key + WEBSOCKET_GUID)
    .digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'),
  );

  clients.add(socket);
  userByConnection.set(socket, authUser);
  sentTimestampsByConnection.set(socket, []);
  readBufferByConnection.set(socket, Buffer.alloc(0));
  serversByConnection.set(socket, new Set());

  sendEvent(socket, { type: 'system', payload: { text: `Connected as ${authUser.username}` } });

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

if (isAiGlobalKillSwitchEnabled()) {
  console.warn('[ai] Global kill switch enabled. AI invocation is disabled for all servers.');
}

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
