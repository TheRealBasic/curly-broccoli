export const APP_NAME = 'Curly Broccoli Chat';

export type ChatMessage = {
  id: string;
  user: string;
  text: string;
  createdAt: string;
};

export type ClientEvent =
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
      payload: { messages: ChatMessage[] };
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
