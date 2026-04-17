import {
  LLMAuthError,
  LLMConfigurationError,
  LLMProviderError,
  LLMProviderNotSupportedError,
  LLMRateLimitError,
  LLMTimeoutError,
  LLMTokenLimitError,
} from './errors';
import type { LLMClient, LLMConfig, LLMGenerateOptions, LLMMessage, LLMProvider, LLMResponse } from './types';

function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds;

  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }

  return undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelayMs(headers: Headers, attempt: number): number {
  const retryAfter = parseRetryAfter(headers);
  if (retryAfter !== undefined) return retryAfter * 1000;
  return Math.min(500 * (2 ** attempt), 5_000);
}

function isRetryableStatus(status: number): boolean {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(status);
}

function mapOpenAIModel(model: string): string {
  return model;
}

function mapAnthropicModel(model: string): string {
  if (model === 'claude-sonnet-4') return 'claude-sonnet-4-20250514';
  if (model === 'claude-opus-4') return 'claude-opus-4-20250514';
  return model;
}

function mapGoogleModel(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model;
}

function isTokenLimitMessage(message: string): boolean {
  return /token|context length|max tokens|context window|too many tokens/i.test(message);
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number, maxRetries: number): Promise<Response> {
  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      if (!isRetryableStatus(response.status) || attempt >= maxRetries) {
        return response;
      }

      await sleep(getRetryDelayMs(response.headers, attempt));
      attempt += 1;
      continue;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new LLMTimeoutError();
      }

      if (attempt >= maxRetries) {
        throw error;
      }

      await sleep(getRetryDelayMs(new Headers(), attempt));
      attempt += 1;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function getProviderBaseUrl(provider: LLMProvider, config: LLMConfig): string {
  if (provider === 'openai') return config.baseUrl ?? 'https://api.openai.com/v1';
  if (provider === 'groq') return config.baseUrl ?? 'https://api.groq.com/openai/v1';
  if (provider === 'anthropic') return config.baseUrl ?? 'https://api.anthropic.com/v1';
  if (provider === 'google') return config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta';
  if (provider === 'openai-compatible') {
    if (!config.baseUrl) throw new LLMConfigurationError('OPENAI_COMPATIBLE_BASE_URL_REQUIRED');
    return config.baseUrl;
  }
  throw new LLMProviderNotSupportedError(provider);
}

function extractOpenAICompatibleText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') {
          return item.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

abstract class BaseLLMClient implements LLMClient {
  constructor(protected readonly config: LLMConfig) {}

  abstract generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse>;

  protected async postJson<T>(url: string, body: unknown, headers: Record<string, string>): Promise<T> {
    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
      },
      this.config.timeoutMs ?? 30000,
      this.config.maxRetries ?? 3,
    );

    const raw = await response.text();

    if (response.status === 401 || response.status === 403) {
      throw new LLMAuthError(this.config.provider, raw || 'LLM authentication failed', parseRetryAfter(response.headers));
    }

    if (response.status === 429) {
      throw new LLMRateLimitError(this.config.provider, raw || 'LLM rate limit exceeded', parseRetryAfter(response.headers));
    }

    if (response.status === 400 || response.status === 413) {
      throw new LLMTokenLimitError(raw || 'LLM token limit exceeded');
    }

    if (!response.ok) {
      if (isTokenLimitMessage(raw)) {
        throw new LLMTokenLimitError(raw || 'LLM token limit exceeded');
      }
      throw new LLMProviderError(this.config.provider, `${this.config.provider} API error: ${response.status}`, response.status, raw);
    }

    if (!raw) {
      return {} as T;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new LLMProviderError(this.config.provider, `${this.config.provider} API returned invalid JSON`, response.status, raw);
    }
  }
}

class OpenAICompatibleClient extends BaseLLMClient {
  async generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse> {
    const baseUrl = getProviderBaseUrl(this.config.provider, this.config);
    const json = await this.postJson<{
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    }>(
      `${baseUrl}/chat/completions`,
      {
        model: mapOpenAIModel(this.config.model),
        messages,
        response_format: options?.responseFormat ? { type: options.responseFormat } : undefined,
        max_tokens: options?.maxTokens,
        temperature: options?.temperature,
      },
      { Authorization: `Bearer ${this.config.apiKey}` },
    );

    return {
      text: extractOpenAICompatibleText(json.choices?.[0]?.message?.content),
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }
}

class AnthropicClient extends BaseLLMClient {
  async generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse> {
    const baseUrl = getProviderBaseUrl('anthropic', this.config);
    const system = messages.find((message) => message.role === 'system')?.content ?? '';
    const chatMessages = messages
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role, content: message.content }));

    const json = await this.postJson<{
      content?: Array<{ text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    }>(
      `${baseUrl}/messages`,
      {
        model: mapAnthropicModel(this.config.model),
        system,
        messages: chatMessages,
        max_tokens: options?.maxTokens ?? 4096,
        temperature: options?.temperature,
      },
      {
        'x-api-key': this.config.apiKey,
        'anthropic-version': '2023-06-01',
      },
    );

    return {
      text: json.content?.map((block) => block.text ?? '').join('') ?? '',
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
      },
    };
  }
}

class GoogleClient extends BaseLLMClient {
  async generate(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse> {
    const baseUrl = getProviderBaseUrl('google', this.config);
    const system = messages.find((message) => message.role === 'system')?.content;
    const chatMessages = messages.filter((message) => message.role !== 'system');

    const json = await this.postJson<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    }>(
      `${baseUrl}/models/${encodeURIComponent(mapGoogleModel(this.config.model))}:generateContent`,
      {
        systemInstruction: system ? { parts: [{ text: system }] } : undefined,
        contents: chatMessages.map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content }],
        })),
        generationConfig: {
          responseMimeType: options?.responseFormat === 'json_object' ? 'application/json' : undefined,
          maxOutputTokens: options?.maxTokens,
          temperature: options?.temperature,
        },
      },
      { 'x-goog-api-key': this.config.apiKey },
    );

    const text = json.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';

    return {
      text,
      usage: {
        inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }
}

const CLIENT_FACTORIES: Record<LLMProvider, (config: LLMConfig) => LLMClient> = {
  openai: (config) => new OpenAICompatibleClient(config),
  groq: (config) => new OpenAICompatibleClient(config),
  'openai-compatible': (config) => new OpenAICompatibleClient(config),
  anthropic: (config) => new AnthropicClient(config),
  google: (config) => new GoogleClient(config),
};

export function createLLMClient(config: LLMConfig): LLMClient {
  const factory = CLIENT_FACTORIES[config.provider];
  if (!factory) throw new LLMProviderNotSupportedError(config.provider);
  return factory(config);
}
