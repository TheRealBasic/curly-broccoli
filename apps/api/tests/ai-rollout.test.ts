import { describe, expect, it } from 'vitest';
import { isAiEnabledForServer, isAiGlobalKillSwitchEnabled, parseAiRolloutStage } from '../src/ai/rollout.js';

describe('AI rollout gating', () => {
  it('rejects invoke when AI rollout does not include the server', () => {
    const env = {
      AI_ROLLOUT_STAGE: 'internal',
      AI_INTERNAL_SERVER_IDS: 'server-1',
    } as NodeJS.ProcessEnv;

    expect(isAiEnabledForServer('server-2', env)).toBe(false);
  });

  it('accepts invoke when AI rollout includes the internal server', () => {
    const env = {
      AI_ROLLOUT_STAGE: 'internal',
      AI_INTERNAL_SERVER_IDS: 'server-1, server-2',
    } as NodeJS.ProcessEnv;

    expect(isAiEnabledForServer('server-2', env)).toBe(true);
  });

  it('supports gradual expansion from internal to beta to full', () => {
    const internalEnv = {
      AI_ROLLOUT_STAGE: 'internal',
      AI_INTERNAL_SERVER_IDS: 'server-internal',
      AI_BETA_SERVER_IDS: 'server-beta',
    } as NodeJS.ProcessEnv;
    expect(isAiEnabledForServer('server-beta', internalEnv)).toBe(false);

    const betaEnv = {
      ...internalEnv,
      AI_ROLLOUT_STAGE: 'beta',
    } as NodeJS.ProcessEnv;
    expect(isAiEnabledForServer('server-beta', betaEnv)).toBe(true);

    const fullEnv = {
      ...internalEnv,
      AI_ROLLOUT_STAGE: 'full',
    } as NodeJS.ProcessEnv;
    expect(isAiEnabledForServer('any-server', fullEnv)).toBe(true);
  });

  it('applies global kill switch as a hard stop', () => {
    const env = {
      AI_ROLLOUT_STAGE: 'full',
      AI_GLOBAL_KILL_SWITCH: 'true',
    } as NodeJS.ProcessEnv;

    expect(isAiGlobalKillSwitchEnabled(env)).toBe(true);
    expect(isAiEnabledForServer('server-1', env)).toBe(false);
  });

  it('defaults unknown rollout stages to internal', () => {
    expect(parseAiRolloutStage('unexpected')).toBe('internal');
  });
});
