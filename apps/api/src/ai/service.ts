import { requestOpenAi } from './openai.js';

export type ChannelAiRequest = {
  requestId: string;
  serverId: string;
  channelId: string;
  requesterUserId: string;
  requesterUsername: string;
  botDisplayName: string;
  prompt: string;
  model: string;
  systemPrompt: string | null;
  maxTokensPerReply: number | null;
  temperature: number | null;
};

export async function requestChannelAiReply(input: ChannelAiRequest) {
  return requestOpenAi({
    provider: 'openai',
    mode: 'responses',
    model: input.model,
    messages: [
      {
        role: 'system',
        content:
          input.systemPrompt?.trim() ||
          `You are ${input.botDisplayName}, a helpful assistant in a team chat channel. Keep replies concise and actionable.`,
      },
      {
        role: 'user',
        content: input.prompt,
      },
    ],
    maxTokens: input.maxTokensPerReply ?? undefined,
    temperature: input.temperature ?? undefined,
    metadata: {
      feature: 'channel_chat_invocation',
      requestId: input.requestId,
      serverId: input.serverId,
      channelId: input.channelId,
      requesterUserId: input.requesterUserId,
      requesterUsername: input.requesterUsername,
      botDisplayName: input.botDisplayName,
    },
  });
}
