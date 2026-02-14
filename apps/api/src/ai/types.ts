export type AiProvider = 'openai';

export type AiRequestMode = 'chat.completions' | 'responses';

export type AiMessageRole = 'system' | 'user' | 'assistant';

export type AiMessage = {
  role: AiMessageRole;
  content: string;
};

export type AiRequestDto = {
  provider: AiProvider;
  mode: AiRequestMode;
  model: string;
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
  metadata?: Record<string, string>;
};

export type AiResponseDto = {
  provider: AiProvider;
  model: string;
  outputText: string;
  finishReason: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  raw: unknown;
};

export type AiErrorCode =
  | 'ai_unavailable'
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'upstream_timeout'
  | 'upstream_error'
  | 'network_error';

export type AiErrorDto = {
  code: AiErrorCode;
  message: string;
  retriable: boolean;
  status: number;
  details?: unknown;
};

export type AiResult =
  | { ok: true; value: AiResponseDto }
  | { ok: false; error: AiErrorDto };
