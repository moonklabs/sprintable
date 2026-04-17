import type { LLMProvider } from './types';

export class LLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMError';
  }
}

export class LLMConfigurationError extends LLMError {
  constructor(message = 'LLM configuration is invalid') {
    super(message);
    this.name = 'LLMConfigurationError';
  }
}

export class LLMProviderNotSupportedError extends LLMConfigurationError {
  constructor(provider: string) {
    super(`LLM provider not supported: ${provider}`);
    this.name = 'LLMProviderNotSupportedError';
  }
}

export class LLMProviderError extends LLMError {
  provider: LLMProvider;
  statusCode?: number;
  responseBody?: string;

  constructor(provider: LLMProvider, message: string, statusCode?: number, responseBody?: string) {
    super(message);
    this.name = 'LLMProviderError';
    this.provider = provider;
    this.statusCode = statusCode;
    this.responseBody = responseBody;
  }
}

export class LLMAuthError extends LLMProviderError {
  retryAfterSeconds?: number;

  constructor(provider: LLMProvider, message = 'LLM authentication failed', retryAfterSeconds?: number) {
    super(provider, message, 401);
    this.name = 'LLMAuthError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class LLMRateLimitError extends LLMProviderError {
  retryAfterSeconds?: number;

  constructor(provider: LLMProvider, message = 'LLM rate limit exceeded', retryAfterSeconds?: number) {
    super(provider, message, 429);
    this.name = 'LLMRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class LLMTimeoutError extends LLMError {
  constructor(message = 'LLM request timed out') {
    super(message);
    this.name = 'LLMTimeoutError';
  }
}

export class LLMTokenLimitError extends LLMError {
  constructor(message = 'LLM token limit exceeded') {
    super(message);
    this.name = 'LLMTokenLimitError';
  }
}
