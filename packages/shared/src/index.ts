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

export type ClientEvent =
  | {
      type: 'chat:join-channel';
      payload: { channelId: string };
    }
  | {
      type: 'chat:send';
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
