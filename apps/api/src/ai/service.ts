import type { ChatMessage } from '@curly-broccoli/shared';
import { assembleChannelAiContext, clampMaxReplyTokens } from './context.js';
import { requestOpenAi } from './openai.js';

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
  temperature: number | null;
};

export async function requestChannelAiReply(input: ChannelAiRequest) {
  const context = assembleChannelAiContext({
    botDisplayName: input.botDisplayName,
    requesterUsername: input.requesterUsername,
    question: input.question,
    recentMessages: input.recentMessages,
    systemPrompt: input.systemPrompt,
  });

  return requestOpenAi({
    provider: 'openai',
    mode: 'responses',
    model: input.model,
    messages: context.messages,
    maxTokens: clampMaxReplyTokens(input.maxTokensPerReply),
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
  });
}
