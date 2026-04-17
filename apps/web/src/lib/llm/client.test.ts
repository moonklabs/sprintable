import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLLMClient } from './client';
import { LLMConfigurationError, LLMRateLimitError } from './errors';
import type { LLMConfig } from './types';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockJsonResponse(payload: unknown, status = 200, headers?: Record<string, string>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(headers ?? {}),
    },
  });
}

function makeConfig(provider: LLMConfig['provider'], overrides?: Partial<LLMConfig>): LLMConfig {
  return {
    provider,
    billingMode: 'managed',
    apiKey: 'test-key',
    model: provider === 'anthropic'
      ? 'claude-sonnet-4'
      : provider === 'google'
        ? 'gemini-2.5-flash'
        : provider === 'groq'
          ? 'llama-3.1-8b-instant'
          : 'gpt-4o-mini',
    timeoutMs: 100,
    maxRetries: 1,
    ...overrides,
  };
}

describe('createLLMClient', () => {
  it('calls OpenAI chat completions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({
      choices: [{ message: { content: 'hello openai' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createLLMClient(makeConfig('openai'));
    const result = await client.generate([{ role: 'user', content: 'hi' }], { responseFormat: 'json_object' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/chat/completions');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
    });
    expect(result).toEqual({
      text: 'hello openai',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  it('calls Anthropic messages API with system prompt split', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({
      content: [{ text: 'hello anthropic' }],
      usage: { input_tokens: 8, output_tokens: 4 },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createLLMClient(makeConfig('anthropic'));
    const result = await client.generate([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hi' },
    ]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/v1/messages');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ 'x-api-key': 'test-key' });
    expect(JSON.parse(String(init.body))).toMatchObject({
      system: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result).toEqual({
      text: 'hello anthropic',
      usage: { inputTokens: 8, outputTokens: 4 },
    });
  });

  it('calls Google generateContent API', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({
      candidates: [{ content: { parts: [{ text: '{"summary":"ok"}' }] } }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6 },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createLLMClient(makeConfig('google'));
    const result = await client.generate([
      { role: 'system', content: 'json only' },
      { role: 'user', content: 'summarize me' },
    ], { responseFormat: 'json_object' });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      headers: expect.objectContaining({ 'x-goog-api-key': 'test-key' }),
    }));
    const payload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(payload).toMatchObject({
      systemInstruction: { parts: [{ text: 'json only' }] },
      generationConfig: { responseMimeType: 'application/json' },
    });
    expect(result).toEqual({
      text: '{"summary":"ok"}',
      usage: { inputTokens: 12, outputTokens: 6 },
    });
  });

  it('routes Groq through OpenAI-compatible chat completions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({
      choices: [{ message: { content: 'hello groq' } }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createLLMClient(makeConfig('groq'));
    const result = await client.generate([{ role: 'user', content: 'hi' }]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(result).toEqual({
      text: 'hello groq',
      usage: { inputTokens: 4, outputTokens: 2 },
    });
  });

  it('requires baseUrl for openai-compatible provider', async () => {
    const client = createLLMClient(makeConfig('openai-compatible'));

    await expect(client.generate([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(LLMConfigurationError);
  });

  it('retries retryable responses before succeeding', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(mockJsonResponse({
        choices: [{ message: { content: 'after retry' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createLLMClient(makeConfig('openai', { maxRetries: 1 }));
    const result = await client.generate([{ role: 'user', content: 'retry me' }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('after retry');
  });

  it('throws rate limit error when retries are exhausted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('still limited', { status: 429, headers: { 'retry-after': '0' } }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createLLMClient(makeConfig('openai', { maxRetries: 0 }));
    await expect(client.generate([{ role: 'user', content: 'retry me' }])).rejects.toBeInstanceOf(LLMRateLimitError);
  });
});
