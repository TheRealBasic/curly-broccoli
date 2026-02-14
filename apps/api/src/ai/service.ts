import type { ChatMessage } from '@curly-broccoli/shared';
import { assembleChannelAiContext, clampMaxReplyTokens } from './context.js';
import { requestOpenAi, requestOpenAiWithStreaming } from './openai.js';

export type ChannelAiRequest = {
  requestId: string;
  serverId: string;
  channelId: string;
  requesterUserId: string;
  requesterUsername: string;
  botDisplayName: string;
  question: string;
  recentMessages: ChatMessage[];
  model: string;
  systemPrompt: string | null;
  maxTokensPerReply: number | null;
  maxCompletionTokens: number | null;
  temperature: number | null;
};

export async function requestChannelAiReply(
  input: ChannelAiRequest,
  options?: { onChunk?: (chunk: string) => void },
) {
  const context = assembleChannelAiContext({
    botDisplayName: input.botDisplayName,
    requesterUsername: input.requesterUsername,
    question: input.question,
    recentMessages: input.recentMessages,
    systemPrompt: input.systemPrompt,
  });

  const request = {
    provider: 'openai' as const,
    mode: 'responses' as const,
    model: input.model,
    messages: context.messages,
    maxTokens: clampMaxReplyTokens(Math.min(input.maxTokensPerReply ?? Infinity, input.maxCompletionTokens ?? Infinity)),
    temperature: input.temperature ?? undefined,
    metadata: {
      feature: 'channel_chat_invocation',
      requestId: input.requestId,
      serverId: input.serverId,
      channelId: input.channelId,
      requesterUserId: input.requesterUserId,
      requesterUsername: input.requesterUsername,
      botDisplayName: input.botDisplayName,
      contextPolicy: context.policy,
      contextTruncated: String(context.truncated),
      estimatedInputTokens: String(context.estimatedInputTokens),
    },
  };

  if (options?.onChunk) {
    return requestOpenAiWithStreaming(request, options.onChunk);
  }

  return requestOpenAi(request);
}
