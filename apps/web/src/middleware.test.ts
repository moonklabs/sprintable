import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { createServerClient } = vi.hoisted(() => ({
  createServerClient: vi.fn(),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient,
}));

import { middleware } from './middleware';

describe('middleware', () => {
  beforeEach(() => {
    createServerClient.mockReset();
  });

  it('bypasses Supabase auth for internal dogfood public paths', async () => {
    const request = new NextRequest('https://app.example.com/internal-dogfood');

    const response = await middleware(request);

    expect(response.status).toBe(200);
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it('bypasses Supabase auth for all /api/* paths', async () => {
    const apiPaths = [
      '/api/v1/bridge/slack/interactions',
      '/api/v1/bridge/teams/events',
      '/api/cron/hitl-timeouts',
      '/api/cron/agent-session-recovery',
      '/api/integrations/mcp/github/callback',
      '/api/notifications',
      '/api/webhooks/agent-runtime',
      '/api/webhooks/payment',
    ];

    for (const path of apiPaths) {
      createServerClient.mockReset();
      const request = new NextRequest(`https://app.example.com${path}`);
      const response = await middleware(request);

      expect(response.status).toBe(200);
      expect(createServerClient).not.toHaveBeenCalled();
    }
  });

  it('redirects protected paths to login when auth refresh throws', async () => {
    createServerClient.mockReturnValue({
      auth: {
        getUser: vi.fn(async () => {
          throw new Error('auth timeout');
        }),
      },
    });

    const request = new NextRequest('https://app.example.com/dashboard');
    const response = await middleware(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.example.com/login');
    expect(createServerClient).toHaveBeenCalledTimes(1);
  });
});
