import { describe, expect, it } from 'vitest';
import {
  getDefaultModel,
  parsePersistedLLMConfig,
  providerSwitchRequiresNewApiKey,
  validateCustomEndpoint,
} from './config';

describe('llm config', () => {
  it('returns default models for all supported providers', () => {
    expect(getDefaultModel('openai')).toBe('gpt-4o-mini');
    expect(getDefaultModel('anthropic')).toBe('claude-sonnet-4');
    expect(getDefaultModel('google')).toBe('gemini-2.5-flash');
    expect(getDefaultModel('groq')).toBe('llama-3.1-8b-instant');
    expect(getDefaultModel('openai-compatible')).toBe('gpt-4o-mini');
  });

  it('normalizes persisted config for openai-compatible endpoints', () => {
    expect(parsePersistedLLMConfig({
      model: 'custom-model',
      baseUrl: 'https://llm.example.com/v1/',
      timeoutMs: 45000,
      maxRetries: 99,
    }, 'openai-compatible')).toEqual({
      model: 'custom-model',
      baseUrl: 'https://llm.example.com/v1',
      timeoutMs: 45000,
      maxRetries: 3,
    });
  });

  it('requires /v1 for openai-like custom endpoints', () => {
    expect(() => validateCustomEndpoint('https://llm.example.com/api', 'openai')).toThrow('OPENAI_BASE_URL_MUST_INCLUDE_V1');
    expect(() => validateCustomEndpoint('https://llm.example.com/api', 'groq')).toThrow('OPENAI_BASE_URL_MUST_INCLUDE_V1');
    expect(() => validateCustomEndpoint('https://llm.example.com/api', 'openai-compatible')).toThrow('OPENAI_BASE_URL_MUST_INCLUDE_V1');
  });

  it('accepts non-openai endpoints without /v1', () => {
    expect(validateCustomEndpoint('https://generativelanguage.googleapis.com', 'google')).toBe('https://generativelanguage.googleapis.com');
  });

  it('requires a fresh key only when the provider changes', () => {
    expect(providerSwitchRequiresNewApiKey(undefined, 'openai')).toBe(false);
    expect(providerSwitchRequiresNewApiKey('openai', 'openai')).toBe(false);
    expect(providerSwitchRequiresNewApiKey('openai', 'google')).toBe(true);
  });
});
