import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@curly-broccoli/shared';
import { assembleChannelAiContext, clampMaxReplyTokens } from '../src/ai/context.js';

function makeMessage(index: number, user = `user${index}`): ChatMessage {
  return {
    id: `m-${index}`,
    channelId: 'c-1',
    userId: `u-${index}`,
    user,
    text: `message ${index}`,
    createdAt: new Date(1_700_000_000_000 + index * 1000).toISOString(),
    attachments: [],
  };
}

describe('assembleChannelAiContext', () => {
  it('includes system prompt, recent messages, and current question', () => {
    const result = assembleChannelAiContext({
      botDisplayName: 'assistant',
      requesterUsername: 'alice',
      question: 'What changed?',
      systemPrompt: 'Be precise.',
      recentMessages: [makeMessage(1), makeMessage(2)],
      messageLimit: 20,
    });

    expect(result.messages[0]).toMatchObject({ role: 'system' });
    expect(result.messages.at(-1)).toEqual({ role: 'user', content: 'alice: What changed?' });
    expect(result.truncated).toBe(false);
    expect(result.policy).toBe('transient_channel_only');
  });

  it('truncates when history exceeds message limit and adds notice', () => {
    const history = Array.from({ length: 30 }, (_, index) => makeMessage(index + 1));

    const result = assembleChannelAiContext({
      botDisplayName: 'assistant',
      requesterUsername: 'alice',
      question: 'Summarize',
      recentMessages: history,
      messageLimit: 20,
    });

    expect(result.truncated).toBe(true);
    expect(result.truncationNotice).toBe('Using recent context only.');
    expect(result.messages.some((message) => message.content === 'Using recent context only.')).toBe(true);
  });
});

describe('clampMaxReplyTokens', () => {
  it('returns undefined for invalid values', () => {
    expect(clampMaxReplyTokens(null)).toBeUndefined();
    expect(clampMaxReplyTokens(0)).toBeUndefined();
  });

  it('caps values at 2048', () => {
    expect(clampMaxReplyTokens(5000)).toBe(2048);
    expect(clampMaxReplyTokens(256)).toBe(256);
  });
});
