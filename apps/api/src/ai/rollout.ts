export type AiRolloutStage = 'disabled' | 'internal' | 'beta' | 'full';

function parseCsvSet(raw: string | undefined) {
  if (!raw) {
    return new Set<string>();
  }

  return new Set(
    raw
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
}

export function parseAiRolloutStage(raw: string | undefined): AiRolloutStage {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'full' || normalized === 'beta' || normalized === 'internal' || normalized === 'disabled') {
    return normalized;
  }

  return 'internal';
}

export function isAiGlobalKillSwitchEnabled(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.AI_GLOBAL_KILL_SWITCH?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'enabled';
}

export function isAiEnabledForServer(serverId: string, env: NodeJS.ProcessEnv = process.env) {
  if (isAiGlobalKillSwitchEnabled(env)) {
    return false;
  }

  const stage = parseAiRolloutStage(env.AI_ROLLOUT_STAGE);
  if (stage === 'disabled') {
    return false;
  }

  if (stage === 'full') {
    return true;
  }

  const internalServers = parseCsvSet(env.AI_INTERNAL_SERVER_IDS);
  if (internalServers.has(serverId)) {
    return true;
  }

  if (stage === 'internal') {
    return false;
  }

  const betaServers = parseCsvSet(env.AI_BETA_SERVER_IDS);
  return betaServers.has(serverId);
}

