import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createSprintableClient } from './index';

describe('createSprintableClient', () => {
  const TEST_API_KEY = 'sk_live_test123';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates client with default empty baseURL', () => {
    const client = createSprintableClient(TEST_API_KEY);

    expect(client.apiKey).toBe(TEST_API_KEY);
    expect(client.axios.defaults.baseURL).toBe('');
  });

  it('creates client with custom baseURL', () => {
    const customBaseURL = 'http://localhost:3000';
    const client = createSprintableClient(TEST_API_KEY, {
      baseURL: customBaseURL,
    });

    expect(client.axios.defaults.baseURL).toBe(customBaseURL);
  });

  it('sets Content-Type header to application/json', () => {
    const client = createSprintableClient(TEST_API_KEY);

    expect(client.axios.defaults.headers['Content-Type']).toBe('application/json');
  });

  it('injects Authorization Bearer token via interceptor', async () => {
    const client = createSprintableClient(TEST_API_KEY);

    // Create a mock adapter to intercept the request
    const mockAdapter = vi.fn((config) => {
      expect(config.headers.Authorization).toBe(`Bearer ${TEST_API_KEY}`);
      return Promise.resolve({ data: { success: true }, status: 200, statusText: 'OK', headers: {}, config });
    });

    client.axios.defaults.adapter = mockAdapter as any;

    await client.axios.get('/api/test');

    expect(mockAdapter).toHaveBeenCalled();
  });

  it('allows custom axios config', () => {
    const client = createSprintableClient(TEST_API_KEY, {
      axiosConfig: {
        timeout: 5000,
        headers: {
          'X-Custom-Header': 'test-value',
        },
      },
    });

    expect(client.axios.defaults.timeout).toBe(5000);
    expect(client.axios.defaults.headers['X-Custom-Header']).toBe('test-value');
  });

  it('preserves Content-Type even with custom headers', () => {
    const client = createSprintableClient(TEST_API_KEY, {
      axiosConfig: {
        headers: {
          'X-Custom-Header': 'test-value',
        },
      },
    });

    expect(client.axios.defaults.headers['Content-Type']).toBe('application/json');
  });
});
