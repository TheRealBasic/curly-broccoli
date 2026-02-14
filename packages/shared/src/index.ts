export const APP_NAME = 'Curly Broccoli Chat';

export type ChatMessage = {
  id: string;
  channelId: string;
  user: string;
  text: string;
  createdAt: string;
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
      payload: { text: string };
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
    };
