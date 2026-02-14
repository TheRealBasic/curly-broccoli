import type { ChatMessage } from '@curly-broccoli/shared';
import type { AiMessage } from './types.js';

const DEFAULT_CONTEXT_MESSAGE_LIMIT = 20;
const MAX_CONTEXT_CHARS = 12_000;
const MAX_MESSAGE_CHARS = 800;
const MAX_QUESTION_CHARS = 2_000;
const MAX_SYSTEM_PROMPT_CHARS = 2_000;

export type ChannelContextAssemblyInput = {
  botDisplayName: string;
  requesterUsername: string;
  question: string;
  recentMessages: ChatMessage[];
  systemPrompt?: string | null;
  messageLimit?: number;
};

export type ChannelContextAssemblyResult = {
  messages: AiMessage[];
  truncated: boolean;
  truncationNotice: string | null;
  estimatedInputTokens: number;
  policy: 'transient_channel_only';
};

function clipText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function estimateTokensByChars(value: string) {
  return Math.ceil(value.length / 4);
}

function toHistoryMessage(message: ChatMessage, botDisplayName: string): AiMessage {
  const speaker = message.user?.trim() || 'unknown';
  const clipped = clipText(message.text.trim(), MAX_MESSAGE_CHARS);
  const isAssistant = speaker.toLowerCase() === botDisplayName.trim().toLowerCase() && !message.userId;

  if (isAssistant) {
    return {
      role: 'assistant',
      content: clipped,
    };
  }

  return {
    role: 'user',
    content: `${speaker}: ${clipped}`,
  };
}

export function assembleChannelAiContext(input: ChannelContextAssemblyInput): ChannelContextAssemblyResult {
  const safeQuestion = clipText(input.question.trim(), MAX_QUESTION_CHARS);
  const messageLimit = Math.max(1, Math.min(input.messageLimit ?? DEFAULT_CONTEXT_MESSAGE_LIMIT, 50));
  const requestedMessages = input.recentMessages.slice(-messageLimit);
  const historyMessages = requestedMessages.map((message) => toHistoryMessage(message, input.botDisplayName));

  const systemSections = [
    input.systemPrompt?.trim()
      ? clipText(input.systemPrompt.trim(), MAX_SYSTEM_PROMPT_CHARS)
      : `You are ${input.botDisplayName}, a helpful assistant in a team chat channel. Keep replies concise and actionable.`,
    'Only use context from this channel. Do not use memory from other channels or DMs unless explicitly enabled.',
  ];

  const messages: AiMessage[] = [
    {
      role: 'system',
      content: systemSections.join('\n\n'),
    },
    ...historyMessages,
    {
      role: 'user',
      content: `${input.requesterUsername}: ${safeQuestion}`,
    },
  ];

  let truncated = input.recentMessages.length > requestedMessages.length;

  while (messages.map((message) => message.content).join('\n').length > MAX_CONTEXT_CHARS && messages.length > 2) {
    messages.splice(1, 1);
    truncated = true;
  }

  const truncationNotice = truncated ? 'Using recent context only.' : null;
  if (truncationNotice) {
    messages.splice(1, 0, {
      role: 'system',
      content: truncationNotice,
    });
  }

  const estimatedInputTokens = messages.reduce((sum, message) => {
    return sum + estimateTokensByChars(message.content);
  }, 0);

  return {
    messages,
    truncated,
    truncationNotice,
    estimatedInputTokens,
    policy: 'transient_channel_only',
  };
}

export function clampMaxReplyTokens(value: number | null | undefined) {
  if (!Number.isFinite(value) || !value || value <= 0) {
    return undefined;
  }

  return Math.min(Math.floor(value), 2_048);
}
