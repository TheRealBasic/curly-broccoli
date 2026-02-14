export const APP_NAME = 'Curly Broccoli Chat';

export type ChatMessage = {
  id: string;
  channelId: string;
  userId?: string | null;
  user: string;
  text: string;
  attachments: MessageAttachment[];
  createdAt: string;
  editedAt?: string | null;
};

export type AttachmentCategory = 'image' | 'audio' | 'video' | 'document' | 'other';

export type MessageAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  category: AttachmentCategory;
  sizeBytes: number;
  url: string;
};

export type ServerSummary = {
  id: string;
  name: string;
  ownerId: string;
  soundboardEnabled: boolean;
  voiceEffectsEnabled: boolean;
};

export type ChannelSummary = {
  id: string;
  serverId: string;
  name: string;
};

export type ServerMember = {
  userId: string;
  username: string;
  role: 'owner' | 'member';
  canShareScreen: boolean;
  isMuted: boolean;
};

export type DmThreadSummary = {
  id: string;
  otherUserId: string;
  otherUsername: string;
  lastMessageAt: string | null;
};

export type DmMessage = {
  id: string;
  threadId: string;
  senderUserId: string;
  senderUsername: string;
  text: string;
  createdAt: string;
};

export type VoiceParticipant = {
  userId: string;
  username: string;
  activeVoiceEffect?: VoiceEffectMode;
};

export type VoiceEffectMode = 'none' | 'robot' | 'megaphone' | 'pitch-shift';

export type StreamType = 'audio' | 'screen';

export type CoWatchMediaSource = {
  sourceType: 'url' | 'upload';
  url: string;
  title?: string;
};

export type CoWatchPlaybackState = {
  media: CoWatchMediaSource;
  paused: boolean;
  positionSec: number;
  lastEventAt: string;
  hostUserId: string;
  controllers: string[];
};

export const SCREEN_SHARE_ROLLOUT_STAGES = ['disabled', 'internal', 'beta', 'full'] as const;
export type ScreenShareRolloutStage = (typeof SCREEN_SHARE_ROLLOUT_STAGES)[number];

export type ClientEvent =
  | {
      type: 'chat:join-channel';
      payload: { channelId: string };
    }
  | {
      type: 'presence:join-server';
      payload: { serverId: string };
    }
  | {
      type: 'typing:start';
      payload: { channelId: string };
    }
  | {
      type: 'typing:stop';
      payload: { channelId: string };
    }
  | {
      type: 'chat:send';
      payload: { text: string; attachmentIds?: string[] };
    }
  | {
      type: 'dm:join-thread';
      payload: { threadId: string };
    }
  | {
      type: 'dm:send';
      payload: { text: string };
    }
  | {
      type: 'ping';
      payload?: Record<string, never>;
    }
  | {
      type: 'voice:join-channel';
      payload: { channelId: string };
    }
  | {
      type: 'voice:leave-channel';
      payload?: Record<string, never>;
    }
  | {
      type: 'voice:signal';
      payload: {
        channelId: string;
        targetUserId: string;
        streamType?: StreamType;
        description?: { type: string; sdp?: string };
        iceRestart?: boolean;
        candidate?: {
          candidate: string;
          sdpMid?: string | null;
          sdpMLineIndex?: number | null;
          usernameFragment?: string | null;
        };
      };
    }
  | {
      type: 'screen:share-start';
      payload: { channelId: string };
    }
  | {
      type: 'screen:share-stop';
      payload: { channelId: string };
    }
  | {
      type: 'screen:force-stop';
      payload: { channelId: string; presenterUserId: string };
    }
  | {
      type: 'screen:signal';
      payload: {
        channelId: string;
        targetUserId: string;
        streamType: StreamType;
        description?: { type: string; sdp?: string };
        candidate?: {
          candidate: string;
          sdpMid?: string | null;
          sdpMLineIndex?: number | null;
          usernameFragment?: string | null;
        };
      };
    }
  | {
      type: 'watch:start';
      payload: {
        channelId: string;
        media: CoWatchMediaSource;
        paused?: boolean;
        positionSec?: number;
        eventAt?: string;
      };
    }
  | {
      type: 'watch:pause';
      payload: { channelId: string; paused: boolean; positionSec: number; eventAt?: string };
    }
  | {
      type: 'watch:seek';
      payload: { channelId: string; positionSec: number; paused: boolean; eventAt?: string };
    }
  | {
      type: 'watch:state';
      payload: { channelId: string };
    }
  | {
      type: 'watch:transfer-host';
      payload: { channelId: string; targetUserId: string };
    }
  | {
      type: 'watch:set-permissions';
      payload: { channelId: string; controllers: string[] };
    }
  | {
      type: 'soundboard:trigger';
      payload: { channelId: string; clipId: string };
    }
  | {
      type: 'voice:effect-state';
      payload: { channelId: string; effect: VoiceEffectMode };
    };

export type ServerEvent =
  | {
      type: 'chat:history';
      payload: { channelId: string; messages: ChatMessage[] };
    }
  | {
      type: 'chat:joined-channel';
      payload: { channelId: string };
    }
  | {
      type: 'chat:message';
      payload: { message: ChatMessage };
    }
  | {
      type: 'chat:bot-pending';
      payload: {
        channelId: string;
        requestId: string;
        requestedByUserId: string;
        botDisplayName: string;
      };
    }
  | {
      type: 'ai:reply-start';
      payload: {
        channelId: string;
        requestId: string;
        requestedByUserId: string;
        botDisplayName: string;
      };
    }
  | {
      type: 'ai:reply-chunk';
      payload: {
        channelId: string;
        requestId: string;
        chunk: string;
      };
    }
  | {
      type: 'ai:reply-complete';
      payload: {
        channelId: string;
        requestId: string;
        message: ChatMessage;
      };
    }
  | {
      type: 'ai:reply-error';
      payload: {
        channelId: string;
        requestId: string;
        message: string;
      };
    }
  | {
      type: 'chat:message-edited';
      payload: { channelId: string; messageId: string; text: string; editedAt: string };
    }
  | {
      type: 'notification:channel-message';
      payload: {
        serverId: string;
        channelId: string;
        messageId: string;
        senderUserId: string;
        senderUsername: string;
        text: string;
      };
    }
  | {
      type: 'dm:history';
      payload: { threadId: string; messages: DmMessage[] };
    }
  | {
      type: 'dm:joined-thread';
      payload: { threadId: string };
    }
  | {
      type: 'dm:message';
      payload: { message: DmMessage };
    }
  | {
      type: 'notification:dm-message';
      payload: {
        threadId: string;
        messageId: string;
        senderUserId: string;
        senderUsername: string;
        text: string;
      };
    }
  | {
      type: 'notification:unread-updated';
      payload: {
        summary: {
          channels: Record<string, number>;
          dmThreads: Record<string, number>;
          totalChannels: number;
          totalDmThreads: number;
        };
      };
    }
  | {
      type: 'presence:sync';
      payload: { serverId: string; onlineUserIds: string[] };
    }
  | {
      type: 'presence:user-online';
      payload: { serverId: string; userId: string };
    }
  | {
      type: 'presence:user-offline';
      payload: { serverId: string; userId: string };
    }
  | {
      type: 'typing:start';
      payload: { channelId: string; userId: string; username: string };
    }
  | {
      type: 'typing:stop';
      payload: { channelId: string; userId: string };
    }
  | {
      type: 'system';
      payload: { text: string };
    }
  | {
      type: 'error';
      payload: { message: string };
    }
  | {
      type: 'pong';
      payload: Record<string, never>;
    }
  | {
      type: 'voice:participants';
      payload: { channelId: string; participants: VoiceParticipant[] };
    }
  | {
      type: 'voice:user-joined';
      payload: { channelId: string; participant: VoiceParticipant };
    }
  | {
      type: 'voice:user-left';
      payload: { channelId: string; userId: string };
    }
  | {
      type: 'voice:signal';
      payload: {
        channelId: string;
        fromUserId: string;
        streamType?: StreamType;
        description?: { type: string; sdp?: string };
        iceRestart?: boolean;
        candidate?: {
          candidate: string;
          sdpMid?: string | null;
          sdpMLineIndex?: number | null;
          usernameFragment?: string | null;
        };
      };
    }
  | {
      type: 'screen:share-start';
      payload: { channelId: string; presenter: VoiceParticipant };
    }
  | {
      type: 'screen:share-stop';
      payload: { channelId: string; presenterUserId: string };
    }
  | {
      type: 'screen:signal';
      payload: {
        channelId: string;
        fromUserId: string;
        streamType: StreamType;
        description?: { type: string; sdp?: string };
        candidate?: {
          candidate: string;
          sdpMid?: string | null;
          sdpMLineIndex?: number | null;
          usernameFragment?: string | null;
        };
      };
    }
  | {
      type: 'screen:viewer-joined';
      payload: { channelId: string; presenterUserId: string; viewer: VoiceParticipant };
    }
  | {
      type: 'screen:viewer-left';
      payload: { channelId: string; presenterUserId: string; userId: string };
    }
  | {
      type: 'moderation:audit';
      payload: {
        channelId: string;
        action:
          | 'screen_share_start'
          | 'screen_share_stop'
          | 'screen_share_force_stop'
          | 'user_unmute'
          | 'member_permission_update';
        actorUserId: string;
        targetUserId?: string;
      };
    }
  | {
      type: 'watch:start';
      payload: { channelId: string; state: CoWatchPlaybackState };
    }
  | {
      type: 'watch:pause';
      payload: { channelId: string; state: CoWatchPlaybackState };
    }
  | {
      type: 'watch:seek';
      payload: { channelId: string; state: CoWatchPlaybackState };
    }
  | {
      type: 'watch:state';
      payload: { channelId: string; state: CoWatchPlaybackState | null };
    }
  | {
      type: 'soundboard:trigger';
      payload: { channelId: string; userId: string; username: string; clipId: string };
    }
  | {
      type: 'voice:effect-state';
      payload: {
        channelId: string;
        userId: string;
        effect: VoiceEffectMode;
      };
    };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isStreamType(value: unknown): value is StreamType {
  return value === 'audio' || value === 'screen';
}

export function parseScreenShareRolloutStage(raw: string | undefined): ScreenShareRolloutStage {
  if (raw === 'internal' || raw === 'beta' || raw === 'full' || raw === 'disabled') {
    return raw;
  }

  return 'full';
}

export function isValidClientEvent(value: unknown): value is ClientEvent {
  if (!isObject(value) || typeof value.type !== 'string') {
    return false;
  }

  const payload = isObject(value.payload) ? value.payload : {};
  if (value.type === 'screen:share-start' || value.type === 'screen:share-stop') {
    return typeof payload.channelId === 'string' && payload.channelId.trim().length > 0;
  }

  if (value.type === 'screen:force-stop') {
    return (
      typeof payload.channelId === 'string' &&
      payload.channelId.trim().length > 0 &&
      typeof payload.presenterUserId === 'string' &&
      payload.presenterUserId.trim().length > 0
    );
  }

  if (value.type === 'screen:signal') {
    return (
      typeof payload.channelId === 'string' &&
      payload.channelId.trim().length > 0 &&
      typeof payload.targetUserId === 'string' &&
      payload.targetUserId.trim().length > 0 &&
      isStreamType(payload.streamType)
    );
  }


  if (value.type === 'soundboard:trigger') {
    return (
      typeof payload.channelId === 'string' &&
      payload.channelId.trim().length > 0 &&
      typeof payload.clipId === 'string' &&
      payload.clipId.trim().length > 0
    );
  }

  if (value.type === 'voice:effect-state') {
    return (
      typeof payload.channelId === 'string' &&
      payload.channelId.trim().length > 0 &&
      (payload.effect === 'none' ||
        payload.effect === 'robot' ||
        payload.effect === 'megaphone' ||
        payload.effect === 'pitch-shift')
    );
  }

  if (value.type === 'watch:start') {
    return (
      typeof payload.channelId === 'string' &&
      payload.channelId.trim().length > 0 &&
      isObject(payload.media) &&
      typeof payload.media.url === 'string' &&
      payload.media.url.trim().length > 0 &&
      (payload.media.sourceType === 'url' || payload.media.sourceType === 'upload')
    );
  }

  if (value.type === 'watch:pause') {
    return (
      typeof payload.channelId === 'string' &&
      payload.channelId.trim().length > 0 &&
      typeof payload.paused === 'boolean' &&
      typeof payload.positionSec === 'number' &&
      Number.isFinite(payload.positionSec)
    );
  }

  if (value.type === 'watch:seek') {
    return (
      typeof payload.channelId === 'string' &&
      payload.channelId.trim().length > 0 &&
      typeof payload.paused === 'boolean' &&
      typeof payload.positionSec === 'number' &&
      Number.isFinite(payload.positionSec)
    );
  }

  if (value.type === 'watch:state') {
    return typeof payload.channelId === 'string' && payload.channelId.trim().length > 0;
  }

  if (value.type === 'watch:transfer-host') {
    return (
      typeof payload.channelId === 'string' &&
      payload.channelId.trim().length > 0 &&
      typeof payload.targetUserId === 'string' &&
      payload.targetUserId.trim().length > 0
    );
  }

  if (value.type === 'watch:set-permissions') {
    return (
      typeof payload.channelId === 'string' &&
      payload.channelId.trim().length > 0 &&
      Array.isArray(payload.controllers) &&
      payload.controllers.every((controller) => typeof controller === 'string')
    );
  }

  return true;
}
