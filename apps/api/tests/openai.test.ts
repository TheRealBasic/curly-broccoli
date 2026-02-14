import { describe, expect, it } from 'vitest';
import {
  createOpenAiConfig,
  mapOpenAiError,
  mapOpenAiHttpError,
  validateOpenAiConfig,
} from '../src/ai/openai.js';

describe('validateOpenAiConfig', () => {
  it('returns ai_unavailable when OPENAI_API_KEY is missing', () => {
    const config = createOpenAiConfig({});

    expect(validateOpenAiConfig(config)).toEqual({
      code: 'ai_unavailable',
      message: 'AI unavailable.',
      retriable: false,
      status: 503,
    });
  });

  it('accepts config when API key exists', () => {
    const config = createOpenAiConfig({ OPENAI_API_KEY: 'key' });
    expect(validateOpenAiConfig(config)).toBeNull();
  });
});

describe('mapOpenAiHttpError', () => {
  it('maps 429 as retriable rate_limited error', () => {
    const error = mapOpenAiHttpError(429, { error: { message: 'Slow down' } });

    expect(error).toMatchObject({
      code: 'rate_limited',
      retriable: true,
      status: 429,
      message: 'Slow down',
    });
  });

  it('maps 401 as unauthorized', () => {
    const error = mapOpenAiHttpError(401, { error: { message: 'Bad key' } });

    expect(error).toMatchObject({
      code: 'unauthorized',
      retriable: false,
      status: 401,
      message: 'Bad key',
    });
  });
});

describe('mapOpenAiError', () => {
  it('maps abort errors to upstream_timeout', () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';

    const mapped = mapOpenAiError(abortError);

    expect(mapped).toMatchObject({
      code: 'upstream_timeout',
      retriable: true,
      status: 504,
    });
  });

  it('maps type errors to network_error', () => {
    const mapped = mapOpenAiError(new TypeError('fetch failed'));

    expect(mapped).toMatchObject({
      code: 'network_error',
      retriable: true,
      status: 502,
    });
  });
});
