import { describe, expect, it } from 'vitest';
import { ApiClientError, createApiClientError, readApiClientError } from './api-client-error';

describe('api-client-error', () => {
  it('parses the standard api envelope and nested meterType details', async () => {
    const response = new Response(JSON.stringify({
      data: null,
      error: {
        code: 'UPGRADE_REQUIRED',
        message: 'Upgrade required',
        details: { meterType: 'ai_calls' },
      },
      meta: null,
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(readApiClientError(response, 'fallback')).resolves.toEqual({
      code: 'UPGRADE_REQUIRED',
      message: 'Upgrade required',
      meterType: 'ai_calls',
      details: { meterType: 'ai_calls' },
    });
  });

  it('preserves legacy top-level upgrade fields during fallback parsing', async () => {
    const response = new Response(JSON.stringify({
      code: 'UPGRADE_REQUIRED',
      message: 'Legacy upgrade response',
      meterType: 'stt_minutes',
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });

    const error = await createApiClientError(response, 'fallback');

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      code: 'UPGRADE_REQUIRED',
      message: 'Legacy upgrade response',
      meterType: 'stt_minutes',
    });
  });

  it('falls back to the provided message when the body is not parseable json', async () => {
    const response = new Response('not-json', {
      status: 500,
      headers: { 'Content-Type': 'text/plain' },
    });

    await expect(readApiClientError(response, 'Request failed')).resolves.toEqual({
      code: undefined,
      message: 'Request failed',
      meterType: undefined,
      details: undefined,
    });
  });
});
