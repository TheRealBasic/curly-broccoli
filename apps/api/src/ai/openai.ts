import path from 'node:path';
import dotenv from 'dotenv';
import type { AiErrorDto, AiRequestDto, AiResponseDto, AiResult } from './types.js';

dotenv.config({ path: path.resolve(process.cwd(), 'apps/api/.env') });
dotenv.config();

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;

export type OpenAiConfig = {
  apiKey: string | null;
  organization: string | null;
  project: string | null;
  timeoutMs: number;
  maxRetries: number;
};

export function createOpenAiConfig(env: NodeJS.ProcessEnv = process.env): OpenAiConfig {
  const timeoutMs = parseNumber(env.OPENAI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxRetries = parseNumber(env.OPENAI_MAX_RETRIES, DEFAULT_MAX_RETRIES);

  return {
    apiKey: env.OPENAI_API_KEY?.trim() || null,
    organization: env.OPENAI_ORG_ID?.trim() || null,
    project: env.OPENAI_PROJECT_ID?.trim() || null,
    timeoutMs,
    maxRetries,
  };
}

function parseNumber(raw: string | undefined, fallback: number) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }

  return parsed;
}

export function validateOpenAiConfig(config: OpenAiConfig): AiErrorDto | null {
  if (!config.apiKey) {
    return {
      code: 'ai_unavailable',
      message: 'AI unavailable.',
      retriable: false,
      status: 503,
    };
  }

  return null;
}

export function buildOpenAiRequestBody(request: AiRequestDto) {
  if (request.mode === 'chat.completions') {
    return {
      model: request.model,
      messages: request.messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      metadata: request.metadata,
    };
  }

  return {
    model: request.model,
    input: request.messages.map((message) => ({
      role: message.role,
      content: [{ type: 'input_text', text: message.content }],
    })),
    max_output_tokens: request.maxTokens,
    temperature: request.temperature,
    metadata: request.metadata,
  };
}

function getEndpoint(mode: AiRequestDto['mode']) {
  if (mode === 'chat.completions') {
    return '/chat/completions';
  }

  return '/responses';
}

function buildHeaders(config: OpenAiConfig) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey ?? ''}`,
    'Content-Type': 'application/json',
  };

  if (config.organization) {
    headers['OpenAI-Organization'] = config.organization;
  }

  if (config.project) {
    headers['OpenAI-Project'] = config.project;
  }

  return headers;
}

export function mapOpenAiError(error: unknown): AiErrorDto {
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      code: 'upstream_timeout',
      message: 'AI request timed out.',
      retriable: true,
      status: 504,
    };
  }

  if (error instanceof TypeError) {
    return {
      code: 'network_error',
      message: 'Unable to reach AI provider.',
      retriable: true,
      status: 502,
      details: error.message,
    };
  }

  return {
    code: 'upstream_error',
    message: 'AI request failed.',
    retriable: false,
    status: 502,
    details: error,
  };
}

export function mapOpenAiHttpError(status: number, body: unknown): AiErrorDto {
  const text =
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof body.error === 'object' &&
    body.error !== null &&
    'message' in body.error &&
    typeof body.error.message === 'string'
      ? body.error.message
      : 'AI request failed.';

  if (status === 400) {
    return { code: 'bad_request', message: text, retriable: false, status, details: body };
  }

  if (status === 401) {
    return { code: 'unauthorized', message: text, retriable: false, status, details: body };
  }

  if (status === 403) {
    return { code: 'forbidden', message: text, retriable: false, status, details: body };
  }

  if (status === 429) {
    return { code: 'rate_limited', message: text, retriable: true, status, details: body };
  }

  if (status >= 500) {
    return { code: 'upstream_error', message: text, retriable: true, status, details: body };
  }

  return { code: 'upstream_error', message: text, retriable: false, status, details: body };
}

type OpenAiChatPayload = {
  model?: string;
  choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

type OpenAiResponsesPayload = {
  model?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  output_text?: string;
  status?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
};

function parseOutput(response: AiRequestDto, payload: unknown): AiResponseDto {
  if (response.mode === 'chat.completions') {
    const chatPayload = (payload ?? {}) as OpenAiChatPayload;

    return {
      provider: 'openai',
      model: chatPayload.model ?? response.model,
      outputText: chatPayload.choices?.[0]?.message?.content ?? '',
      finishReason: chatPayload.choices?.[0]?.finish_reason ?? null,
      usage: {
        inputTokens: chatPayload.usage?.prompt_tokens ?? 0,
        outputTokens: chatPayload.usage?.completion_tokens ?? 0,
        totalTokens: chatPayload.usage?.total_tokens ?? 0,
      },
      raw: payload,
    };
  }

  const responsesPayload = (payload ?? {}) as OpenAiResponsesPayload;
  const outputText = Array.isArray(responsesPayload.output)
    ? responsesPayload.output
        .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
        .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
        .map((part) => part.text ?? '')
        .join('\n')
    : responsesPayload.output_text ?? '';

  return {
    provider: 'openai',
    model: responsesPayload.model ?? response.model,
    outputText,
    finishReason: responsesPayload.status ?? null,
    usage: {
      inputTokens: responsesPayload.usage?.input_tokens ?? 0,
      outputTokens: responsesPayload.usage?.output_tokens ?? 0,
      totalTokens: responsesPayload.usage?.total_tokens ?? 0,
    },
    raw: payload,
  };
}

export async function requestOpenAi(
  request: AiRequestDto,
  config = createOpenAiConfig(),
): Promise<AiResult> {
  const configError = validateOpenAiConfig(config);
  if (configError) {
    return { ok: false, error: configError };
  }

  const endpoint = `${OPENAI_BASE_URL}${getEndpoint(request.mode)}`;
  const body = JSON.stringify(buildOpenAiRequestBody(request));

  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: buildHeaders(config),
        body,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const payload = await response.json().catch(() => ({ error: { message: 'Invalid JSON response.' } }));
      if (!response.ok) {
        const mappedError = mapOpenAiHttpError(response.status, payload);
        if (mappedError.retriable && attempt < config.maxRetries) {
          continue;
        }

        return { ok: false, error: mappedError };
      }

      return { ok: true, value: parseOutput(request, payload) };
    } catch (error) {
      clearTimeout(timeout);
      const mappedError = mapOpenAiError(error);
      if (mappedError.retriable && attempt < config.maxRetries) {
        continue;
      }

      return { ok: false, error: mappedError };
    }
  }

  return {
    ok: false,
    error: {
      code: 'upstream_error',
      message: 'AI request failed after retries.',
      retriable: false,
      status: 502,
    },
  };
}

type StreamChunkHandler = (chunk: string) => void;

function extractTextFromSsePayload(mode: AiRequestDto['mode'], payload: unknown): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  if (mode === 'chat.completions') {
    const chunk = payload as {
      choices?: Array<{ delta?: { content?: string } }>;
    };
    return chunk.choices?.[0]?.delta?.content ?? '';
  }

  const responsesChunk = payload as {
    type?: string;
    delta?: string;
  };

  if (responsesChunk.type === 'response.output_text.delta' && typeof responsesChunk.delta === 'string') {
    return responsesChunk.delta;
  }

  return '';
}

function parseSseEventData(chunk: string): string[] {
  return chunk
    .split('\n\n')
    .map((eventBlock) =>
      eventBlock
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join(''),
    )
    .filter((line) => line.length > 0 && line !== '[DONE]');
}

export async function requestOpenAiWithStreaming(
  request: AiRequestDto,
  onChunk: StreamChunkHandler,
  config = createOpenAiConfig(),
): Promise<AiResult> {
  const configError = validateOpenAiConfig(config);
  if (configError) {
    return { ok: false, error: configError };
  }

  const endpoint = `${OPENAI_BASE_URL}${getEndpoint(request.mode)}`;
  const body = JSON.stringify({
    ...buildOpenAiRequestBody(request),
    stream: true,
  });

  for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
    let streamedOutput = '';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: buildHeaders(config),
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        clearTimeout(timeout);
        const payload = await response
          .json()
          .catch(() => ({ error: { message: 'Invalid JSON response.' } }));
        const mappedError = mapOpenAiHttpError(response.status, payload);
        if (mappedError.retriable && attempt < config.maxRetries) {
          continue;
        }
        return { ok: false, error: mappedError };
      }

      if (!response.body) {
        clearTimeout(timeout);
        return requestOpenAi(request, config);
      }

      const decoder = new TextDecoder();
      let sseBuffer = '';

      for await (const part of response.body) {
        sseBuffer += decoder.decode(part, { stream: true });
        const boundary = sseBuffer.lastIndexOf('\n\n');
        if (boundary === -1) {
          continue;
        }

        const completeEvents = sseBuffer.slice(0, boundary);
        sseBuffer = sseBuffer.slice(boundary + 2);

        for (const eventData of parseSseEventData(completeEvents)) {
          const payload = JSON.parse(eventData) as unknown;
          const textChunk = extractTextFromSsePayload(request.mode, payload);
          if (!textChunk) {
            continue;
          }

          streamedOutput += textChunk;
          onChunk(textChunk);
        }
      }

      clearTimeout(timeout);

      if (!streamedOutput.trim()) {
        return requestOpenAi(request, config);
      }

      return {
        ok: true,
        value: {
          provider: 'openai',
          model: request.model,
          outputText: streamedOutput,
          finishReason: 'completed',
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
          },
          raw: null,
        },
      };
    } catch (error) {
      clearTimeout(timeout);
      const mappedError = mapOpenAiError(error);
      if (mappedError.retriable && attempt < config.maxRetries) {
        continue;
      }

      return requestOpenAi(request, config);
    }
  }

  return requestOpenAi(request, config);
}
