import { describe, expect, it } from 'vitest';
import {
  isStreamType,
  isValidClientEvent,
  parseScreenShareRolloutStage,
  type ClientEvent,
} from './index.js';

describe('screen-share protocol validators', () => {
  it('validates stream type values', () => {
    expect(isStreamType('audio')).toBe(true);
    expect(isStreamType('screen')).toBe(true);
    expect(isStreamType('video')).toBe(false);
  });

  it('validates screen signal payload requirements', () => {
    const valid: ClientEvent = {
      type: 'screen:signal',
      payload: {
        channelId: 'channel-1',
        targetUserId: 'user-2',
        streamType: 'screen',
      },
    };

    expect(isValidClientEvent(valid)).toBe(true);
    expect(
      isValidClientEvent({
        type: 'screen:signal',
        payload: { channelId: 'channel-1', targetUserId: 'user-2', streamType: 'video' },
      }),
    ).toBe(false);
  });

  it('validates share lifecycle payload requirements', () => {
    expect(
      isValidClientEvent({ type: 'screen:share-start', payload: { channelId: 'channel-1' } }),
    ).toBe(true);
    expect(isValidClientEvent({ type: 'screen:share-start', payload: { channelId: '' } })).toBe(
      false,
    );

    expect(
      isValidClientEvent({
        type: 'screen:force-stop',
        payload: { channelId: 'channel-1', presenterUserId: 'user-1' },
      }),
    ).toBe(true);
    expect(
      isValidClientEvent({
        type: 'screen:force-stop',
        payload: { channelId: 'channel-1', presenterUserId: '' },
      }),
    ).toBe(false);
  });


  it('validates co-watch payload requirements', () => {
    expect(
      isValidClientEvent({
        type: 'watch:start',
        payload: {
          channelId: 'channel-1',
          media: { sourceType: 'url', url: 'https://example.com/video.mp4' },
        },
      }),
    ).toBe(true);

    expect(
      isValidClientEvent({
        type: 'watch:start',
        payload: { channelId: 'channel-1', media: { sourceType: 'invalid', url: 'x' } },
      }),
    ).toBe(false);

    expect(
      isValidClientEvent({
        type: 'watch:seek',
        payload: { channelId: 'channel-1', paused: false, positionSec: 12 },
      }),
    ).toBe(true);
  });


  it('validates playful audio event payload requirements', () => {
    expect(
      isValidClientEvent({
        type: 'soundboard:trigger',
        payload: { channelId: 'channel-1', clipId: 'boing' },
      }),
    ).toBe(true);
    expect(
      isValidClientEvent({
        type: 'soundboard:trigger',
        payload: { channelId: 'channel-1', clipId: '' },
      }),
    ).toBe(false);

    expect(
      isValidClientEvent({
        type: 'voice:effect-state',
        payload: { channelId: 'channel-1', effect: 'robot' },
      }),
    ).toBe(true);
    expect(
      isValidClientEvent({
        type: 'voice:effect-state',
        payload: { channelId: 'channel-1', effect: 'alien' },
      }),
    ).toBe(false);
  });

  it('parses rollout stage with safe fallback', () => {
    expect(parseScreenShareRolloutStage('internal')).toBe('internal');
    expect(parseScreenShareRolloutStage('beta')).toBe('beta');
    expect(parseScreenShareRolloutStage('full')).toBe('full');
    expect(parseScreenShareRolloutStage('disabled')).toBe('disabled');
    expect(parseScreenShareRolloutStage('unexpected')).toBe('full');
    expect(parseScreenShareRolloutStage(undefined)).toBe('full');
  });
});
