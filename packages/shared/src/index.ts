export const APP_NAME = 'Curly Broccoli Chat';

export type ChatMessage = {
  id: string;
  channelId: string;
  userId?: string | null;
  user: string;
  text: string;
  attachments: MessageAttachment[];
  createdAt: string;
};

export type MessageAttachment = {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
};

export type ServerSummary = {
  id: string;
  name: string;
  ownerId: string;
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
};

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
        description?: { type: string; sdp?: string };
        candidate?: {
          candidate: string;
          sdpMid?: string | null;
          sdpMLineIndex?: number | null;
          usernameFragment?: string | null;
        };
      };
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
        description?: { type: string; sdp?: string };
        candidate?: {
          candidate: string;
          sdpMid?: string | null;
          sdpMLineIndex?: number | null;
          usernameFragment?: string | null;
        };
      };
    };
