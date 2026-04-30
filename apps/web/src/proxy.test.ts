import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

vi.mock('jose', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jose')>();
  return actual;
});

import { proxy as middleware } from './proxy';

const JWT_SECRET = 'test-secret-for-proxy-tests';

async function makeAccessToken(overrides: { exp?: number; type?: string } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ type: overrides.type ?? 'access', email: 'test@example.com' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-123')
    .setIssuedAt(now)
    .setExpirationTime(overrides.exp ?? now + 900)
    .sign(new TextEncoder().encode(JWT_SECRET));
}

function makeRequest(path: string, cookies: Record<string, string> = {}): NextRequest {
  const req = new NextRequest(`https://app.example.com${path}`);
  for (const [name, value] of Object.entries(cookies)) {
    req.cookies.set(name, value);
  }
  return req;
}

describe('proxy', () => {
  beforeEach(() => {
    delete process.env['OSS_MODE'];
    process.env['JWT_SECRET'] = JWT_SECRET;
    process.env['NEXT_PUBLIC_FASTAPI_URL'] = 'http://localhost:8000';
    mockFetch.mockReset();
  });

  afterEach(() => {
    delete process.env['OSS_MODE'];
    delete process.env['JWT_SECRET'];
  });

  describe('OSS_MODE=true', () => {
    beforeEach(() => { process.env['OSS_MODE'] = 'true'; });

    it('redirects / to /inbox (AC-4)', async () => {
      const response = await middleware(makeRequest('/'));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('https://app.example.com/inbox');
    });

    it('redirects /login to /inbox (AC-5)', async () => {
      const response = await middleware(makeRequest('/login'));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('https://app.example.com/inbox');
    });

    it('redirects /auth/callback to /inbox (AC-5)', async () => {
      const response = await middleware(makeRequest('/auth/callback?code=abc'));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('https://app.example.com/inbox');
    });

    it('passes /dashboard through without JWT auth (AC-1)', async () => {
      const response = await middleware(makeRequest('/dashboard'));
      expect(response.status).toBe(200);
    });

    it('passes /api/ routes through without JWT auth', async () => {
      const response = await middleware(makeRequest('/api/stories'));
      expect(response.status).toBe(200);
    });
  });

  it('passes public paths without JWT check', async () => {
    for (const path of ['/internal-dogfood', '/login', '/api/notifications']) {
      const response = await middleware(makeRequest(path));
      expect(response.status).toBe(200);
    }
  });

  it('passes all /api/* paths without JWT check', async () => {
    const apiPaths = [
      '/api/v1/bridge/slack/interactions',
      '/api/cron/hitl-timeouts',
      '/api/integrations/mcp/github/callback',
      '/api/webhooks/agent-runtime',
    ];
    for (const path of apiPaths) {
      const response = await middleware(makeRequest(path));
      expect(response.status).toBe(200);
    }
  });

  it('redirects to login when no sp_at cookie and refresh fails', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({ error: { code: 'TOKEN_REVOKED' } }) });
    const response = await middleware(makeRequest('/dashboard'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.example.com/login');
  });

  it('redirects to login when no sp_at and no sp_rt cookie', async () => {
    const response = await middleware(makeRequest('/dashboard'));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.example.com/login');
  });

  it('allows access with valid sp_at cookie', async () => {
    const token = await makeAccessToken();
    const response = await middleware(makeRequest('/dashboard', { sp_at: token }));
    expect(response.status).toBe(200);
  });

  it('redirects to login with invalid sp_at and no refresh token', async () => {
    const response = await middleware(makeRequest('/dashboard', { sp_at: 'not.a.valid.jwt' }));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://app.example.com/login');
  });

  it('refreshes token when sp_at is expiring soon', async () => {
    const now = Math.floor(Date.now() / 1000);
    const soonExpiring = await makeAccessToken({ exp: now + 200 }); // < 300s remaining
    const newAt = await makeAccessToken({ exp: now + 900 });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { access_token: newAt, refresh_token: 'new-rt' } }),
    });
    const response = await middleware(makeRequest('/dashboard', { sp_at: soonExpiring, sp_rt: 'old-rt' }));
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('/api/v2/auth/refresh'), expect.any(Object));
  });

  it('refreshes when sp_at missing but sp_rt present', async () => {
    const now = Math.floor(Date.now() / 1000);
    const newAt = await makeAccessToken({ exp: now + 900 });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { access_token: newAt, refresh_token: 'new-rt' } }),
    });
    const response = await middleware(makeRequest('/dashboard', { sp_rt: 'valid-rt' }));
    expect(response.status).toBe(200);
    const setCookieHeader = response.headers.get('set-cookie');
    expect(setCookieHeader).toContain('sp_at=');
  });

  it('blocks Agent API key from UI routes', async () => {
    const req = new NextRequest('https://app.example.com/dashboard');
    req.headers.set('Authorization', 'Bearer sk_agent_key');
    const response = await middleware(req);
    expect(response.status).toBe(403);
  });
});
